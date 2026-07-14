import http from "node:http";
import crypto from "node:crypto";
import { io } from "socket.io-client";
import { loadEnvFile } from "@http-tunnel/shared/env-file";
import { clearSessions, createLoginRateLimiter, ensureAdmin, requireAuth, login, logout, currentUser } from "@http-tunnel/shared/auth";
import { stripBaseUrl } from "@http-tunnel/shared/base-url";
import { applyCors } from "@http-tunnel/shared/cors";
import {
  createMapping as createStoredMapping,
  deleteMapping as deleteStoredMapping,
  isConfigured,
  listMappings,
  loadSettings,
  saveSettings,
  updateMapping as updateStoredMapping
} from "./db.js";
import { json, readJson, toHeaderObject } from "@http-tunnel/shared/http-utils";
import { createLogger } from "@http-tunnel/shared/logger";
import { mappingTarget } from "@http-tunnel/shared/mappings";
import { hashPassword } from "@http-tunnel/shared/password";
import { envBoolean, envList, envPositiveInteger } from "@http-tunnel/shared/runtime-config";
import { serveStaticWeb } from "@http-tunnel/shared/static-web";
import { FRAME, decodeFrame, encodeFrame, isRequestId, writeStream } from "@http-tunnel/shared/stream-protocol";
import { TUNNEL_EVENT, isTunnelConnected, sendTunnel } from "@http-tunnel/shared/tunnel-transport";
import { validatePort } from "@http-tunnel/shared/validators";

loadEnvFile(".env.client");

const listenConfig = {
  adminHost: process.env.ADMIN_HOST || "0.0.0.0",
  adminPort: Number(process.env.ADMIN_PORT || 12500),
  corsOrigins: envList("CORS_ORIGINS"),
  trustProxy: envBoolean("TRUST_PROXY"),
  secureCookies: envBoolean("SECURE_COOKIES"),
  sessionTtlMs: envPositiveInteger("SESSION_TTL_MS", 12 * 60 * 60 * 1000),
  maxSessions: envPositiveInteger("MAX_SESSIONS", 1000),
  maxConcurrentRequests: envPositiveInteger("MAX_CONCURRENT_REQUESTS", 256),
  maxConcurrentRequestsPerMapping: envPositiveInteger("MAX_CONCURRENT_REQUESTS_PER_MAPPING", 64),
  maxWsPayloadBytes: envPositiveInteger("MAX_WS_PAYLOAD_BYTES", 2 * 1024 * 1024),
  maxHeaderBytes: envPositiveInteger("MAX_HEADER_BYTES", 16 * 1024),
  maxReconnectDelayMs: envPositiveInteger("MAX_RECONNECT_DELAY_MS", 15000, { min: 500 })
};
const config = {
  ...listenConfig,
  ...loadSettings(),
  mappings: listMappings(),
  loginRateLimiter: createLoginRateLimiter({ trustProxy: listenConfig.trustProxy }),
  upgradePassword(password) {
    Object.assign(config, saveSettings({ ...publicConfig(), adminPassword: hashPassword(password) }));
  }
};
ensureAdmin(config);

const logger = createLogger("client");
const RECONNECT_JITTER_RATIO = 0.2;
let currentSocket = null;
let lastError = "";
let connectorStarted = false;
let reconnectAttempt = 0;
let connectedAt = "";
const activeRequests = new Map();
const mappingStats = new Map();
const remoteMappingStatuses = new Map();

function statsFor(id) {
  if (!mappingStats.has(id)) {
    mappingStats.set(id, {
      requestCount: 0,
      errorCount: 0,
      activeRequests: 0,
      bytesIn: 0,
      bytesOut: 0,
      rateInBps: 0,
      rateOutBps: 0,
      lastRateAt: Date.now(),
      lastRateBytesIn: 0,
      lastRateBytesOut: 0,
      lastAccessAt: ""
    });
  }
  return mappingStats.get(id);
}

function updateRates(stats) {
  const now = Date.now();
  const elapsed = (now - stats.lastRateAt) / 1000;
  if (elapsed <= 0) return stats;
  stats.rateInBps = Math.max(0, Math.round((stats.bytesIn - stats.lastRateBytesIn) / elapsed));
  stats.rateOutBps = Math.max(0, Math.round((stats.bytesOut - stats.lastRateBytesOut) / elapsed));
  stats.lastRateAt = now;
  stats.lastRateBytesIn = stats.bytesIn;
  stats.lastRateBytesOut = stats.bytesOut;
  return stats;
}

function publicConfig() {
  return {
    adminUser: config.adminUser,
    baseUrl: config.baseUrl,
    serverUrl: config.serverUrl,
    tunnelToken: config.tunnelToken,
    clientId: config.clientId,
    reconnectMs: config.reconnectMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes
  };
}

function reloadMappings() {
  config.mappings = listMappings();
}

function applySavedSettings(next) {
  const previousBaseUrl = config.baseUrl;
  const previousAdminUser = config.adminUser;
  const previousConnection = JSON.stringify({
    serverUrl: config.serverUrl,
    tunnelToken: config.tunnelToken,
    clientId: config.clientId,
    reconnectMs: config.reconnectMs
  });
  Object.assign(config, listenConfig, next);
  ensureAdmin(config);
  const currentConnection = JSON.stringify({
    serverUrl: config.serverUrl,
    tunnelToken: config.tunnelToken,
    clientId: config.clientId,
    reconnectMs: config.reconnectMs
  });
  if (previousConnection !== currentConnection && connectorStarted) restartConnection("config updated");
  return {
    redirectBaseUrl: previousBaseUrl !== config.baseUrl ? config.baseUrl : "",
    adminUserChanged: previousAdminUser !== config.adminUser
  };
}

async function setup(req, res) {
  try {
    if (isConfigured(config)) return json(res, 409, { ok: false, error: "already configured" });
    const body = await readJson(req, config.maxResponseBytes);
    if (!body.adminUser || !body.adminPassword) {
      return json(res, 400, { ok: false, error: "admin user and password are required" });
    }
    const result = applySavedSettings(saveSettings({
      baseUrl: body.baseUrl || "/",
      adminUser: body.adminUser,
      adminPassword: body.adminPassword,
      serverUrl: body.serverUrl,
      tunnelToken: body.tunnelToken || "",
      clientId: body.clientId,
      reconnectMs: body.reconnectMs,
      requestTimeoutMs: body.requestTimeoutMs,
      maxResponseBytes: body.maxResponseBytes
    }));
    startConnector();
    logger.info("client configured", { baseUrl: config.baseUrl, clientId: config.clientId });
    json(res, 200, { ok: true, app: "client", configured: true, ...result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function updateConfig(req, res) {
  try {
    const body = await readJson(req, config.maxResponseBytes);
    const shouldClearSessions = Boolean(body.adminPassword);
    const result = applySavedSettings(saveSettings({
      baseUrl: body.baseUrl || config.baseUrl,
      adminUser: body.adminUser || config.adminUser,
      adminPassword: body.adminPassword || config.adminPassword,
      serverUrl: body.serverUrl || config.serverUrl,
      tunnelToken: body.tunnelToken || "",
      clientId: body.clientId || config.clientId,
      reconnectMs: body.reconnectMs,
      requestTimeoutMs: body.requestTimeoutMs,
      maxResponseBytes: body.maxResponseBytes
    }));
    if (shouldClearSessions || result.adminUserChanged) clearSessions();
    logger.info("client config updated", { baseUrl: config.baseUrl, clientId: config.clientId });
    json(res, 200, { ok: true, config: publicConfig(), ...result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

function remoteServerPort() {
  try {
    const url = new URL(config.serverUrl);
    if (url.port) return Number(url.port);
    return url.protocol === "wss:" ? 443 : 80;
  } catch {
    return 0;
  }
}

function validateMappingInput(body, currentId = "") {
  const serverPort = validatePort(body.serverPort, "serverPort");
  const clientPort = validatePort(body.clientPort, "clientPort");
  const duplicate = config.mappings.find((mapping) => mapping.serverPort === serverPort && mapping.id !== currentId);
  if (duplicate) throw new Error(`serverPort ${serverPort} is already used by ${duplicate.name}`);
  if (serverPort === remoteServerPort()) throw new Error("serverPort cannot equal the server management port");
  if (clientPort === listenConfig.adminPort) throw new Error("clientPort cannot expose the client management port");
  return {
    name: String(body.name || "mapping").trim() || "mapping",
    serverPort,
    clientHost: String(body.clientHost || "127.0.0.1").trim(),
    clientPort,
    enabled: body.enabled !== false
  };
}

function buildConnectOptions() {
  const url = new URL(config.serverUrl);
  const path = url.pathname;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return {
    origin: url.origin,
    options: {
      path,
      transports: ["websocket"],
      upgrade: false,
      auth: { clientId: config.clientId },
      query: { clientId: config.clientId },
      extraHeaders: connectHeaders(),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: config.reconnectMs,
      reconnectionDelayMax: Math.max(config.reconnectMs, config.maxReconnectDelayMs),
      randomizationFactor: RECONNECT_JITTER_RATIO,
      transportOptions: { websocket: { perMessageDeflate: false } }
    }
  };
}

function connectHeaders() {
  return config.tunnelToken ? { authorization: `Bearer ${config.tunnelToken}` } : {};
}

function sendMappings() {
  if (!isTunnelConnected(currentSocket)) return;
  void sendTunnel(currentSocket, { type: "mappings", mappings: config.mappings });
}

function isConnected() {
  return isTunnelConnected(currentSocket) && currentSocket.serverVerified === true;
}

function verifyServerConnection(socket) {
  if (currentSocket !== socket || socket.serverVerified) return;
  socket.serverVerified = true;
  reconnectAttempt = 0;
  lastError = "";
  logger.info("server connection verified", { serverUrl: config.serverUrl });
}

function restartConnection(reason = "connection restart requested") {
  const socket = currentSocket;
  if (socket) {
    logger.info("restarting server connection", { reason });
    failActiveRequests(socket, reason);
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    currentSocket = null;
  }
  connectorStarted = false;
  reconnectAttempt = 0;
  connectedAt = "";
  startConnector();
}

function startConnector() {
  if (connectorStarted || !isConfigured(config)) return;
  connectorStarted = true;
  const { origin, options } = buildConnectOptions();
  const socket = io(origin, options);
  currentSocket = socket;

  socket.on("connect", () => {
    socket.serverVerified = false;
    reconnectAttempt = 0;
    connectedAt = new Date().toISOString();
    lastError = "";
    logger.info("socket.io connected", { serverUrl: config.serverUrl, mappings: config.mappings.length });
    void sendTunnel(socket, { type: "hello", mappings: config.mappings });
  });
  socket.on("connect_error", (error) => {
    lastError = error.message;
    logger.error("connection error", { error: error.message });
  });
  socket.io.on("reconnect_attempt", (attempt) => {
    reconnectAttempt = attempt;
    logger.info("socket.io reconnect attempt", { attempt });
  });
  socket.io.on("reconnect_error", (error) => {
    lastError = error.message;
  });
  socket.on("disconnect", (reason) => {
    if (currentSocket !== socket) return;
    remoteMappingStatuses.clear();
    failActiveRequests(socket, "server disconnected");
    connectedAt = "";
    logger.warn("disconnected from server", { reason });
  });
  socket.on(TUNNEL_EVENT, async (payload, acknowledge) => {
    if (currentSocket !== socket) {
      acknowledge?.();
      return;
    }
    if (Buffer.isBuffer(payload)) {
      const frame = decodeFrame(payload);
      if (frame?.type === FRAME.REQUEST_BODY) {
        verifyServerConnection(socket);
        await handleRequestBody(frame.id, frame.chunk);
      }
      acknowledge?.();
      return;
    }
    if (!payload || typeof payload !== "object") {
      acknowledge?.();
      return;
    }
    if (payload.type === "request-start" && isRequestId(payload.id)) {
      verifyServerConnection(socket);
      handleRequestStart(socket, payload);
    }
    if (payload.type === "request-end" && isRequestId(payload.id)) {
      verifyServerConnection(socket);
      await handleRequestEnd(socket, payload.id);
    }
    if (payload.type === "mapping-status") {
      if (!Array.isArray(payload.mappings)) {
        acknowledge?.();
        return;
      }
      verifyServerConnection(socket);
      remoteMappingStatuses.clear();
      for (const item of payload.mappings) {
        if (item.id) remoteMappingStatuses.set(item.id, item);
      }
    }
    if (payload.type === "request-error" && isRequestId(payload.id)) {
      verifyServerConnection(socket);
      const active = activeRequests.get(payload.id);
      if (active) destroyActiveRequest(active, payload.error || "request error");
      if (active) finishActiveRequest(payload.id, active.mapping, true);
    }
    acknowledge?.();
  });
}

function mappingStatus(mapping) {
  if (!mapping.enabled) return "disabled";
  if (!isConnected()) return "disconnected";
  return remoteMappingStatuses.get(mapping.id)?.status || "connected";
}

function mappingStatusMessage(mapping) {
  if (!isConnected()) return "";
  return remoteMappingStatuses.get(mapping.id)?.statusMessage || "";
}

function findMapping(id) {
  return config.mappings.find((mapping) => mapping.id === id);
}

function sendResponseError(ws, id, error) {
  void sendTunnel(ws, { type: "response-error", id, error });
}

function createLocalIdleTimer(ws, id, mapping, active) {
  const timeout = () => {
    if (!activeRequests.has(id)) return;
    sendResponseError(ws, id, "local request idle timed out");
    finishActiveRequest(id, mapping, true);
    destroyActiveRequest(active, "local request idle timed out");
  };
  return {
    timer: setTimeout(timeout, config.requestTimeoutMs),
    reset() {
      clearTimeout(this.timer);
      this.timer = setTimeout(timeout, config.requestTimeoutMs);
    }
  };
}

function finishActiveRequest(id, mapping, hadError = false) {
  const active = activeRequests.get(id);
  if (!active) return;
  if (active.idle) clearTimeout(active.idle.timer);
  if (hadError) statsFor(mapping.id).errorCount += 1;
  statsFor(mapping.id).activeRequests = Math.max(0, statsFor(mapping.id).activeRequests - 1);
  activeRequests.delete(id);
}

function destroyActiveRequest(active, errorMessage) {
  const error = new Error(errorMessage);
  active.localRes?.destroy(error);
  active.localReq.destroy(error);
}

function failActiveRequests(ws, errorMessage) {
  for (const [id, active] of activeRequests.entries()) {
    if (ws && active.ws !== ws) continue;
    destroyActiveRequest(active, errorMessage);
    finishActiveRequest(id, active.mapping, true);
  }
}

function handleRequestStart(ws, message) {
  const mapping = findMapping(message.mappingId);
  if (!mapping || !mapping.enabled) {
    sendResponseError(ws, message.id, "mapping is not available");
    return;
  }

  const stats = statsFor(mapping.id);
  stats.requestCount += 1;
  stats.lastAccessAt = new Date().toISOString();
  if (
    activeRequests.size >= config.maxConcurrentRequests ||
    stats.activeRequests >= config.maxConcurrentRequestsPerMapping
  ) {
    stats.errorCount += 1;
    sendResponseError(ws, message.id, "client concurrency limit reached");
    logger.warn("client concurrency limit reached", {
      requestId: message.id,
      mappingId: mapping.id,
      activeRequests: activeRequests.size
    });
    return;
  }
  stats.activeRequests += 1;

  const targetUrl = new URL(message.url || "/", mappingTarget(mapping));
  const headers = toHeaderObject(message.headers || {});
  delete headers.host;
  delete headers["content-length"];

  const hasBody = !["GET", "HEAD"].includes((message.method || "GET").toUpperCase());
  const localReq = http.request(targetUrl, {
    method: message.method || "GET",
    headers
  }, (localRes) => {
    if (!activeRequests.has(message.id)) {
      localRes.destroy();
      return;
    }
    active.localRes = localRes;
    active.idle.reset();
    void sendTunnel(ws, {
      type: "response-start",
      id: message.id,
      statusCode: localRes.statusCode || 200,
      headers: toHeaderObject(localRes.headers)
    });

    localRes.on("data", async (chunk) => {
      localRes.pause();
      active.idle.reset();
      stats.bytesOut += chunk.length;
      const sent = await sendTunnel(ws, encodeFrame(FRAME.RESPONSE_BODY, message.id, chunk));
      if (!sent) localReq.destroy(new Error("server tunnel is not available"));
      else localRes.resume();
    });

    localRes.on("end", () => {
      active.idle.reset();
      void sendTunnel(ws, { type: "response-end", id: message.id });
      finishActiveRequest(message.id, mapping);
    });

    localRes.on("error", (error) => {
      if (!activeRequests.has(message.id)) return;
      sendResponseError(ws, message.id, error.message);
      finishActiveRequest(message.id, mapping, true);
    });
  });

  localReq.on("error", (error) => {
    if (!activeRequests.has(message.id)) return;
    sendResponseError(ws, message.id, error.message);
    finishActiveRequest(message.id, mapping, true);
  });

  const active = { ws, mapping, localReq, localRes: null, hasBody, localEnded: false, idle: null, writeQueue: Promise.resolve() };
  active.idle = createLocalIdleTimer(ws, message.id, mapping, active);
  activeRequests.set(message.id, active);
  if (!hasBody) {
    active.localEnded = true;
    localReq.end();
  }
}

async function handleRequestBody(id, chunk) {
  const active = activeRequests.get(id);
  if (!active) return;
  active.idle.reset();
  statsFor(active.mapping.id).bytesIn += chunk.length;
  if (!active.hasBody) return;
  active.writeQueue = active.writeQueue.then(() => writeStream(active.localReq, chunk));
  await active.writeQueue;
}

async function handleRequestEnd(ws, id) {
  const active = activeRequests.get(id);
  if (!active || active.localEnded) return;
  try {
    await active.writeQueue;
    active.idle.reset();
    active.localEnded = true;
    active.localReq.end();
  } catch (error) {
    active.localReq.destroy(error);
  }
}

function statusPayload(req) {
  reloadMappings();
  return {
    ok: true,
    app: "client",
    user: currentUser(req, config) ? { username: config.adminUser } : null,
    config: publicConfig(),
    connected: isConnected(),
    connectedAt,
    transport: currentSocket?.connected ? currentSocket.io.engine.transport.name : "",
    lastError,
    reconnectAttempt,
    limits: {
      maxConcurrentRequests: config.maxConcurrentRequests,
      maxConcurrentRequestsPerMapping: config.maxConcurrentRequestsPerMapping,
      maxWsPayloadBytes: config.maxWsPayloadBytes,
      maxReconnectDelayMs: config.maxReconnectDelayMs
    },
    mappings: config.mappings.map((mapping) => ({ ...mapping, status: mappingStatus(mapping), statusMessage: mappingStatusMessage(mapping), stats: updateRates(statsFor(mapping.id)) })),
    logs: logger.entries
  };
}

const adminServer = http.createServer({ maxHeaderSize: config.maxHeaderBytes }, async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (applyCors(req, res, { allowedOrigins: config.corsOrigins })) return;
  const routedPath = stripBaseUrl(url.pathname, config.baseUrl);

  if (url.pathname === "/healthz") return json(res, 200, { ok: true, app: "client" });
  if (url.pathname === "/api/setup/status") {
    return json(res, 200, {
      ok: true,
      app: "client",
      configured: isConfigured(config),
      baseUrl: config.baseUrl,
      user: currentUser(req, config) ? { username: config.adminUser } : null
    });
  }
  if (url.pathname === "/api/setup" && req.method === "POST") return setup(req, res);

  if (routedPath === null) return json(res, 404, { ok: false, error: "not found" });
  if (config.baseUrl !== "/" && url.pathname === config.baseUrl) {
    res.writeHead(308, { location: `${config.baseUrl}/${url.search}` });
    res.end();
    return;
  }

  if (routedPath === "/api/app") return json(res, 200, { ok: true, app: "client" });
  if (routedPath === "/api/setup/status") {
    return json(res, 200, {
      ok: true,
      app: "client",
      configured: isConfigured(config),
      baseUrl: config.baseUrl,
      user: currentUser(req, config) ? { username: config.adminUser } : null
    });
  }
  if (routedPath === "/api/setup" && req.method === "POST") return setup(req, res);
  if (routedPath === "/api/auth/login" && req.method === "POST") return login(req, res, config);
  if (routedPath === "/api/auth/logout" && req.method === "POST") return logout(req, res, config);
  if (!routedPath.startsWith("/api/")) {
    if (serveStaticWeb(req, res, undefined, routedPath)) return;
    return json(res, 404, { ok: false, error: "not found" });
  }

  if (!requireAuth(req, res, config)) return;

  if (routedPath === "/api/auth/me") return json(res, 200, { ok: true, user: { username: config.adminUser } });
  if (routedPath === "/api/status") return json(res, 200, statusPayload(req));
  if (routedPath === "/api/config" && req.method === "GET") return json(res, 200, { ok: true, config: publicConfig() });
  if (routedPath === "/api/config" && req.method === "PUT") return updateConfig(req, res);
  if (routedPath === "/api/restart" && req.method === "POST") {
    restartConnection("manual restart", { force: true });
    logger.info("client connection restart requested", { user: currentUser(req, config) || "" });
    return json(res, 200, { ok: true });
  }

  if (routedPath === "/api/mappings" && req.method === "POST") {
    try {
      const body = await readJson(req, 1024 * 64);
      createStoredMapping({ id: crypto.randomUUID(), ...validateMappingInput(body) });
      reloadMappings();
      sendMappings();
      return json(res, 200, statusPayload(req));
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  const mappingMatch = routedPath.match(/^\/api\/mappings\/([^/]+)$/);
  if (mappingMatch && req.method === "PUT") {
    const mapping = findMapping(mappingMatch[1]);
    if (!mapping) return json(res, 404, { ok: false, error: "mapping not found" });
    try {
      const body = await readJson(req, 1024 * 64);
      updateStoredMapping(mappingMatch[1], validateMappingInput({ ...mapping, ...body }, mappingMatch[1]));
      reloadMappings();
      sendMappings();
      return json(res, 200, statusPayload(req));
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (mappingMatch && req.method === "DELETE") {
    deleteStoredMapping(mappingMatch[1]);
    reloadMappings();
    sendMappings();
    return json(res, 200, statusPayload(req));
  }

  json(res, 404, { ok: false, error: "not found" });
});

adminServer.listen(listenConfig.adminPort, listenConfig.adminHost, () => {
  logger.info("client api listening", { host: listenConfig.adminHost, port: listenConfig.adminPort });
});

startConnector();
