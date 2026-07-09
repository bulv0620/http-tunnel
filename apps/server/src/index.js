import http from "node:http";
import { WebSocketServer } from "ws";
import { loadEnvFile } from "@http-tunnel/shared/env-file";
import { clearSessions, createLoginRateLimiter, ensureAdmin, requireAuth, login, logout, currentUser } from "@http-tunnel/shared/auth";
import { clientIp, redact } from "@http-tunnel/shared/audit";
import { stripBaseUrl } from "@http-tunnel/shared/base-url";
import { applyCors } from "@http-tunnel/shared/cors";
import { addAuditLog, isConfigured, listAuditLogs, loadSettings, saveSettings } from "./db.js";
import { json, readJson, toHeaderObject } from "@http-tunnel/shared/http-utils";
import { createLogger } from "@http-tunnel/shared/logger";
import { normalizeMappings } from "@http-tunnel/shared/mappings";
import { hashPassword } from "@http-tunnel/shared/password";
import { serveStaticWeb } from "@http-tunnel/shared/static-web";
import { FRAME, createRequestId, decodeFrame, encodeFrame, sendWs, writeStream } from "@http-tunnel/shared/stream-protocol";

loadEnvFile(".env.server");

const listenConfig = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 12400)
};
const config = {
  ...listenConfig,
  ...loadSettings(),
  loginRateLimiter: createLoginRateLimiter(),
  audit(event, data = {}, req) {
    const actor = data.username || currentUser(req, config) || "";
    addAuditLog(event, { actor, ip: data.ip || (req ? clientIp(req) : ""), data });
  },
  upgradePassword(password) {
    Object.assign(config, saveSettings({ ...publicConfig(), adminPassword: hashPassword(password) }));
  }
};
ensureAdmin(config);

const logger = createLogger("server");
const WS_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 15000;
const pending = new Map();
const mappingServers = new Map();
const mappingSpecs = new Map();
const mappingStats = new Map();
const mappingListenErrors = new Map();
let client = null;
let clientUpgradeInProgress = false;
let mappings = [];

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

function mappingStatus(mapping) {
  const server = mappingServers.get(mapping.id);
  if (!mapping.enabled) return "disabled";
  if (mappingListenErrors.has(mapping.id)) return "error";
  if (!server) return "stopped";
  if (!client || client.readyState !== WS_OPEN) return "disconnected";
  return server.listening ? "connected" : "error";
}

function mappingStatusMessage(mapping) {
  return mappingListenErrors.get(mapping.id) || "";
}

function mappingStatusPayload() {
  return mappings.map((mapping) => ({
    id: mapping.id,
    status: mappingStatus(mapping),
    statusMessage: mappingStatusMessage(mapping)
  }));
}

function sendMappingStatus(ws = client) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  return sendWs(ws, JSON.stringify({ type: "mapping-status", mappings: mappingStatusPayload() }));
}

function stopRemovedMappings(nextMappings) {
  const nextIds = new Set(nextMappings.filter((item) => item.enabled).map((item) => item.id));
  for (const [id, server] of mappingServers.entries()) {
    if (nextIds.has(id)) continue;
    server.close();
    mappingServers.delete(id);
    mappingSpecs.delete(id);
    mappingStats.delete(id);
    mappingListenErrors.delete(id);
  }
}

function startMapping(mapping) {
  if (!mapping.enabled || mappingServers.has(mapping.id)) return;
  const server = http.createServer((req, res) => handleMappedRequest(mapping, req, res));
  mappingListenErrors.delete(mapping.id);
  server.on("error", (error) => {
    mappingListenErrors.set(mapping.id, error.message);
    logger.error("mapping listen failed", {
      id: mapping.id,
      serverPort: mapping.serverPort,
      error: error.message
    });
    void sendMappingStatus();
  });
  server.listen(mapping.serverPort, config.host, () => {
    mappingListenErrors.delete(mapping.id);
    logger.info("mapping listening", {
      id: mapping.id,
      serverPort: mapping.serverPort,
      clientHost: mapping.clientHost,
      clientPort: mapping.clientPort
    });
    void sendMappingStatus();
  });
  mappingServers.set(mapping.id, server);
  mappingSpecs.set(mapping.id, JSON.stringify(mapping));
}

function applyMappings(nextMappings) {
  const normalized = normalizeMappings(nextMappings);
  stopRemovedMappings(normalized);
  for (const mapping of normalized) {
    const previous = mappingSpecs.get(mapping.id);
    const current = JSON.stringify(mapping);
    if (previous && previous !== current) {
      mappingServers.get(mapping.id)?.close();
      mappingServers.delete(mapping.id);
      mappingSpecs.delete(mapping.id);
      mappingListenErrors.delete(mapping.id);
    }
  }
  mappings = normalized;
  for (const mapping of mappings) startMapping(mapping);
}

async function sendToClient(payload) {
  if (!client || client.readyState !== WS_OPEN) return false;
  return sendWs(client, JSON.stringify(payload));
}

function finishPending(id, errorMessage = "") {
  const item = pending.get(id);
  if (!item) return null;
  clearTimeout(item.idle.timer);
  pending.delete(id);
  const stats = statsFor(item.mappingId);
  if (errorMessage) stats.errorCount += 1;
  stats.activeRequests = Math.max(0, stats.activeRequests - 1);
  return item;
}

function createIdleTimer(id, res) {
  const timeout = () => {
    const item = finishPending(id, "tunnel request idle timed out");
    if (!item) return;
    if (!res.headersSent) res.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
    res.end("tunnel request idle timed out");
  };
  return {
    timer: setTimeout(timeout, config.requestTimeoutMs),
    reset() {
      clearTimeout(this.timer);
      this.timer = setTimeout(timeout, config.requestTimeoutMs);
    }
  };
}

async function handleMappedRequest(mapping, req, res) {
  if (!client || client.readyState !== WS_OPEN) {
    json(res, 502, { ok: false, error: "client is not connected" });
    return;
  }

  const id = createRequestId();
  const stats = statsFor(mapping.id);
  stats.requestCount += 1;
  stats.activeRequests += 1;
  stats.lastAccessAt = new Date().toISOString();
  const idle = createIdleTimer(id, res);
  pending.set(id, { res, idle, resetTimer: () => idle.reset(), mappingId: mapping.id, responded: false, writeQueue: Promise.resolve() });
  const sent = await sendToClient({
    type: "request-start",
    id,
    mappingId: mapping.id,
    method: req.method,
    url: req.url,
    headers: toHeaderObject(req.headers)
  });
  if (!sent) {
    finishPending(id, "client is not connected");
    json(res, 502, { ok: false, error: "client is not connected" });
    return;
  }

  req.on("data", async (chunk) => {
    req.pause();
    pending.get(id)?.resetTimer();
    stats.bytesIn += chunk.length;
    if (!(await sendToClientBinary(encodeFrame(FRAME.REQUEST_BODY, id, chunk)))) {
      req.destroy();
      return;
    }
    req.resume();
  });
  req.on("end", () => {
    pending.get(id)?.resetTimer();
    void sendToClient({ type: "request-end", id });
  });
  req.on("error", (error) => {
    pending.get(id)?.resetTimer();
    void sendToClient({ type: "request-error", id, error: error.message });
  });
}

async function sendToClientBinary(payload) {
  if (!client || client.readyState !== WS_OPEN) return false;
  return sendWs(client, payload, { binary: true });
}

function startResponse(payload) {
  const item = pending.get(payload.id);
  if (!item) return;
  item.resetTimer();

  if (payload.error) {
    item.res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    item.res.end(payload.error);
    finishPending(payload.id, payload.error);
    return;
  }

  const headers = toHeaderObject(payload.headers || {});
  item.res.writeHead(payload.statusCode || 200, headers);
  item.responded = true;
}

async function writeResponseBody(id, chunk) {
  const item = pending.get(id);
  if (!item || !item.responded) return;
  item.resetTimer();
  item.writeQueue = item.writeQueue.then(async () => {
    statsFor(item.mappingId).bytesOut += chunk.length;
    await writeStream(item.res, chunk);
  });
  await item.writeQueue;
}

async function endResponse(payload) {
  const item = pending.get(payload.id);
  if (!item) return;
  item.resetTimer();
  await item.writeQueue;
  if (!pending.has(payload.id)) return;
  if (!item.responded) {
    item.res.writeHead(payload.error ? 502 : 200, { "content-type": "text/plain; charset=utf-8" });
  }
  if (payload.error) item.res.end(payload.error);
  else item.res.end();
  finishPending(payload.id, payload.error || "");
}

function failPending(error) {
  for (const [id, item] of pending.entries()) {
    item.res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    item.res.end(error);
    finishPending(id, error);
  }
}

function statusPayload(req) {
  return {
    ok: true,
    app: "server",
    user: currentUser(req, config) ? { username: config.adminUser } : null,
    client: client ? {
      id: client.clientId,
      connectedAt: client.connectedAt,
      latencyMs: client.latencyMs ?? null,
      lastPongAt: client.lastPongAt || ""
    } : null,
    mappings: mappings.map((mapping) => ({ ...mapping, status: mappingStatus(mapping), statusMessage: mappingStatusMessage(mapping), stats: updateRates(statsFor(mapping.id)) })),
    pending: pending.size,
    logs: logger.entries,
    auditLogs: listAuditLogs(100)
  };
}

function publicConfig() {
  return {
    baseUrl: config.baseUrl,
    adminUser: config.adminUser,
    tunnelToken: config.tunnelToken,
    requestTimeoutMs: config.requestTimeoutMs,
    maxBodyBytes: config.maxBodyBytes
  };
}

function closeClient(code, reason) {
  if (!client || client.readyState !== WS_OPEN) return;
  client.close(code, reason);
}

function applySavedSettings(next) {
  const wasConfigured = isConfigured(config);
  const previousBaseUrl = config.baseUrl;
  const previousAdminUser = config.adminUser;
  const previousTunnelToken = config.tunnelToken;
  Object.assign(config, listenConfig, next);
  ensureAdmin(config);
  if ((!wasConfigured && isConfigured(config)) || previousTunnelToken !== config.tunnelToken) {
    closeClient(4003, "server tunnel token changed");
  }
  return {
    redirectBaseUrl: previousBaseUrl !== config.baseUrl ? config.baseUrl : "",
    adminUserChanged: previousAdminUser !== config.adminUser
  };
}

async function setup(req, res) {
  try {
    if (isConfigured(config)) return json(res, 409, { ok: false, error: "already configured" });
    const body = await readJson(req, config.maxBodyBytes);
    if (!body.adminUser || !body.adminPassword) {
      return json(res, 400, { ok: false, error: "admin user and password are required" });
    }
    const result = applySavedSettings(saveSettings({
      baseUrl: body.baseUrl || "/",
      adminUser: body.adminUser,
      adminPassword: body.adminPassword,
      tunnelToken: body.tunnelToken || "",
      requestTimeoutMs: body.requestTimeoutMs,
      maxBodyBytes: body.maxBodyBytes
    }));
    logger.info("server configured", { baseUrl: config.baseUrl });
    addAuditLog("server_configured", { actor: body.adminUser, ip: clientIp(req), data: { baseUrl: config.baseUrl, tunnelToken: redact(config.tunnelToken) } });
    json(res, 200, { ok: true, app: "server", configured: true, ...result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

async function updateConfig(req, res) {
  try {
    const body = await readJson(req, config.maxBodyBytes);
    const actor = currentUser(req, config) || "";
    const shouldClearSessions = Boolean(body.adminPassword);
    const result = applySavedSettings(saveSettings({
      baseUrl: body.baseUrl || config.baseUrl,
      adminUser: body.adminUser || config.adminUser,
      adminPassword: body.adminPassword || config.adminPassword,
      tunnelToken: body.tunnelToken || "",
      requestTimeoutMs: body.requestTimeoutMs,
      maxBodyBytes: body.maxBodyBytes
    }));
    if (shouldClearSessions || result.adminUserChanged) clearSessions();
    logger.info("server config updated", { baseUrl: config.baseUrl });
    addAuditLog("server_config_updated", { actor, ip: clientIp(req), data: { baseUrl: config.baseUrl, tunnelToken: redact(config.tunnelToken) } });
    json(res, 200, { ok: true, config: publicConfig(), ...result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (applyCors(req, res)) return;
  const routedPath = stripBaseUrl(url.pathname, config.baseUrl);

  if (url.pathname === "/healthz") return json(res, 200, { ok: true, app: "server" });
  if (url.pathname === "/api/setup/status") {
    return json(res, 200, {
      ok: true,
      app: "server",
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

  if (routedPath === "/api/app") return json(res, 200, { ok: true, app: "server" });
  if (routedPath === "/api/setup/status") {
    return json(res, 200, {
      ok: true,
      app: "server",
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

  json(res, 404, { ok: false, error: "not found" });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/_tunnel/ws") {
    socket.destroy();
    return;
  }

  const clientId = url.searchParams.get("clientId") || "";
  const rejectTunnel = (statusCode, statusText, event, data = {}) => {
    addAuditLog(event, { ip: clientIp(req), data: { clientId, ...data } });
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\n\r\n`);
    socket.destroy();
  };

  if (!isConfigured(config) || !config.tunnelToken) {
    rejectTunnel(503, "Service Unavailable", "tunnel_rejected_unconfigured");
    return;
  }

  const auth = String(req.headers.authorization || "");
  const headerToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = headerToken || url.searchParams.get("token") || "";
  if (token !== config.tunnelToken) {
    rejectTunnel(401, "Unauthorized", "tunnel_auth_failed");
    return;
  }

  if (clientUpgradeInProgress || (client && client.readyState === WS_OPEN)) {
    rejectTunnel(409, "Conflict", "tunnel_client_rejected", { reason: "client already connected" });
    return;
  }

  clientUpgradeInProgress = true;
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.clientId = clientId || "client";
      ws.connectedAt = new Date().toISOString();
      ws.isAlive = true;
      ws.lastPongAt = "";
      ws.latencyMs = null;
      wss.emit("connection", ws, req);
    });
  } catch {
    clientUpgradeInProgress = false;
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  clientUpgradeInProgress = false;
  client = ws;
  logger.info("client connected", { clientId: ws.clientId });
  addAuditLog("client_connected", { actor: ws.clientId, data: { clientId: ws.clientId } });

  ws.on("pong", (payload) => {
    ws.isAlive = true;
    const sentAt = Number(payload.toString());
    if (Number.isFinite(sentAt)) ws.latencyMs = Date.now() - sentAt;
    ws.lastPongAt = new Date().toISOString();
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      const frame = decodeFrame(raw);
      if (frame?.type === FRAME.RESPONSE_BODY) void writeResponseBody(frame.id, frame.chunk);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (payload.type === "hello" || payload.type === "mappings") {
      applyMappings(payload.mappings || []);
      logger.info("mappings updated", { count: mappings.length });
      addAuditLog("mappings_updated", { actor: ws.clientId, data: { count: mappings.length } });
      void sendMappingStatus(ws);
      return;
    }
    if (payload.type === "response-start" && payload.id) startResponse(payload);
    if (payload.type === "response-end" && payload.id) void endResponse(payload);
    if (payload.type === "response-error" && payload.id) void endResponse(payload);
  });

  ws.on("close", () => {
    if (client === ws) client = null;
    failPending("client disconnected");
    logger.warn("client disconnected", { clientId: ws.clientId });
    addAuditLog("client_disconnected", { actor: ws.clientId, data: { clientId: ws.clientId } });
  });
});

setInterval(() => {
  if (!client || client.readyState !== WS_OPEN) return;
  if (client.isAlive === false) {
    logger.warn("client heartbeat timed out", { clientId: client.clientId });
    client.terminate();
    return;
  }
  client.isAlive = false;
  client.ping(String(Date.now()));
}, HEARTBEAT_INTERVAL_MS).unref();

server.listen(listenConfig.port, listenConfig.host, () => {
  logger.info("server listening", { host: listenConfig.host, port: listenConfig.port });
});
