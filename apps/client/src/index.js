import http from "node:http";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import { loadEnvFile } from "@http-tunnel/shared/env-file";
import { clearSessions, ensureAdmin, requireAuth, login, logout, currentUser } from "@http-tunnel/shared/auth";
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
import { serveStaticWeb } from "@http-tunnel/shared/static-web";
import { FRAME, decodeFrame, encodeFrame, sendWs, writeStream } from "@http-tunnel/shared/stream-protocol";
import { validatePort } from "@http-tunnel/shared/validators";

loadEnvFile(".env.client");

const listenConfig = {
  adminHost: process.env.ADMIN_HOST || "0.0.0.0",
  adminPort: Number(process.env.ADMIN_PORT || 12500)
};
const config = {
  ...listenConfig,
  ...loadSettings(),
  mappings: listMappings(),
  upgradePassword(password) {
    Object.assign(config, saveSettings({ ...publicConfig(), adminPassword: hashPassword(password) }));
  }
};
ensureAdmin(config);

const logger = createLogger("client");
const WS_OPEN = 1;
const WS_CLOSING = 2;
const RESTART_FORCE_CLOSE_MS = 1000;
const RESTART_RESUME_MS = 2000;
let currentWs = null;
let reconnectNow;
let wakeReconnectDelay;
let skipNextReconnectDelay = false;
let lastError = "";
let lastServerPingAt = "";
let connectorStarted = false;
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

function buildConnectUrl() {
  const url = new URL(config.serverUrl);
  url.searchParams.set("clientId", config.clientId);
  return url;
}

function connectHeaders() {
  return config.tunnelToken ? { authorization: `Bearer ${config.tunnelToken}` } : {};
}

function sendMappings() {
  if (!currentWs || currentWs.readyState !== WS_OPEN) return;
  void sendWs(currentWs, JSON.stringify({ type: "mappings", mappings: config.mappings }));
}

function isConnected() {
  return currentWs?.readyState === WS_OPEN;
}

function wakeConnector() {
  if (reconnectNow) reconnectNow();
  if (wakeReconnectDelay) wakeReconnectDelay();
}

function restartConnection(reason = "connection restart requested", options = {}) {
  skipNextReconnectDelay = !wakeReconnectDelay;
  const ws = currentWs;
  if (!ws) {
    wakeConnector();
    return;
  }

  let done = false;
  let forceTimer;
  let resumeTimer;
  const resume = () => {
    if (done) return;
    done = true;
    clearTimeout(forceTimer);
    clearTimeout(resumeTimer);
    wakeConnector();
  };

  ws.once("close", resume);
  try {
    if (ws.readyState === WS_OPEN || ws.readyState === WS_CLOSING) ws.close(4001, reason);
    else ws.terminate();
  } catch {
    ws.terminate();
  }

  if (options.force) {
    forceTimer = setTimeout(() => {
      if (!done && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }, RESTART_FORCE_CLOSE_MS);
  }
  resumeTimer = setTimeout(resume, options.force ? RESTART_RESUME_MS : config.reconnectMs);
}

async function waitBeforeReconnect() {
  if (skipNextReconnectDelay) {
    skipNextReconnectDelay = false;
    return;
  }
  let wake;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, config.reconnectMs);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
    wakeReconnectDelay = wake;
  });
  if (wakeReconnectDelay === wake) wakeReconnectDelay = null;
}

function startConnector() {
  if (connectorStarted || !isConfigured(config)) return;
  connectorStarted = true;
  connectForever();
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
  void sendWs(ws, JSON.stringify({ type: "response-error", id, error }));
}

function createLocalIdleTimer(ws, id, mapping, localReq) {
  const timeout = () => {
    if (!activeRequests.has(id)) return;
    sendResponseError(ws, id, "local request idle timed out");
    finishActiveRequest(id, mapping, true);
    localReq.destroy(new Error("local request idle timed out"));
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

function failActiveRequests(ws, errorMessage) {
  for (const [id, active] of activeRequests.entries()) {
    if (ws && active.ws !== ws) continue;
    active.localReq.destroy(new Error(errorMessage));
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
  stats.activeRequests += 1;
  stats.lastAccessAt = new Date().toISOString();

  const targetUrl = new URL(message.url || "/", mappingTarget(mapping));
  const headers = toHeaderObject(message.headers || {});
  delete headers.host;
  delete headers["content-length"];

  const hasBody = !["GET", "HEAD"].includes((message.method || "GET").toUpperCase());
  const localReq = http.request(targetUrl, {
    method: message.method || "GET",
    headers
  }, (localRes) => {
    active.idle.reset();
    void sendWs(ws, JSON.stringify({
      type: "response-start",
      id: message.id,
      statusCode: localRes.statusCode || 200,
      headers: toHeaderObject(localRes.headers)
    }));

    localRes.on("data", async (chunk) => {
      localRes.pause();
      active.idle.reset();
      stats.bytesOut += chunk.length;
      const sent = await sendWs(ws, encodeFrame(FRAME.RESPONSE_BODY, message.id, chunk), { binary: true });
      if (!sent) localReq.destroy(new Error("server websocket is not available"));
      else localRes.resume();
    });

    localRes.on("end", () => {
      active.idle.reset();
      void sendWs(ws, JSON.stringify({ type: "response-end", id: message.id }));
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

  const active = { ws, mapping, localReq, hasBody, localEnded: false, idle: null, writeQueue: Promise.resolve() };
  active.idle = createLocalIdleTimer(ws, message.id, mapping, localReq);
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

async function connectForever() {
  while (true) {
    const url = buildConnectUrl();

    await new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: connectHeaders() });
      currentWs = ws;
      reconnectNow = resolve;

      ws.on("open", () => {
        lastError = "";
        logger.info("connected to server", { serverUrl: url.origin + url.pathname, mappings: config.mappings.length });
        void sendWs(ws, JSON.stringify({ type: "hello", mappings: config.mappings }));
      });
      ws.on("ping", () => {
        lastServerPingAt = new Date().toISOString();
      });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          const frame = decodeFrame(raw);
          if (frame?.type === FRAME.REQUEST_BODY) void handleRequestBody(frame.id, frame.chunk);
          return;
        }

        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.type === "request-start" && message.id) handleRequestStart(ws, message);
        if (message.type === "request-end" && message.id) handleRequestEnd(ws, message.id);
        if (message.type === "mapping-status") {
          remoteMappingStatuses.clear();
          for (const item of message.mappings || []) {
            if (item.id) remoteMappingStatuses.set(item.id, item);
          }
        }
        if (message.type === "request-error" && message.id) {
          const active = activeRequests.get(message.id);
          active?.localReq.destroy(new Error(message.error || "request error"));
          if (active) finishActiveRequest(message.id, active.mapping, true);
        }
      });
      ws.on("close", () => {
        if (currentWs === ws) {
          currentWs = null;
          failActiveRequests(ws, "server disconnected");
          logger.warn("disconnected from server", { reconnectMs: config.reconnectMs });
        } else {
          logger.info("stale server connection closed");
        }
        resolve();
      });
      ws.on("error", (error) => {
        if (currentWs === ws) {
          lastError = error.message;
          logger.error("connection error", { error: error.message });
        } else {
          logger.info("stale server connection error ignored", { error: error.message });
        }
        ws.close();
      });
    });

    reconnectNow = null;
    await waitBeforeReconnect();
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
    lastError,
    lastServerPingAt,
    mappings: config.mappings.map((mapping) => ({ ...mapping, status: mappingStatus(mapping), statusMessage: mappingStatusMessage(mapping), stats: updateRates(statsFor(mapping.id)) })),
    logs: logger.entries
  };
}

const adminServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (applyCors(req, res)) return;
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
  if (routedPath === "/api/auth/logout" && req.method === "POST") return logout(req, res);
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
