import http from "node:http";
import { WebSocketServer } from "ws";
import { loadEnvFile } from "@http-tunnel/shared/env-file";
import { clearSessions, createLoginRateLimiter, ensureAdmin, requireAuth, login, logout, currentUser } from "@http-tunnel/shared/auth";
import { clientIp, redact } from "@http-tunnel/shared/audit";
import { stripBaseUrl } from "@http-tunnel/shared/base-url";
import { applyCors } from "@http-tunnel/shared/cors";
import { addAuditLog, isConfigured, listAuditLogs, loadSettings, saveSettings } from "./db.js";
import {
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_LOOP_LAG_MS,
  TUNNEL_HEARTBEAT_RECOVERY_MS,
  TUNNEL_HEARTBEAT_STALE_MS
} from "@http-tunnel/shared/heartbeat";
import { json, readJson, toHeaderObject } from "@http-tunnel/shared/http-utils";
import { createLogger } from "@http-tunnel/shared/logger";
import { normalizeMappings } from "@http-tunnel/shared/mappings";
import { hashPassword } from "@http-tunnel/shared/password";
import { envBoolean, envList, envPositiveInteger } from "@http-tunnel/shared/runtime-config";
import { serveStaticWeb } from "@http-tunnel/shared/static-web";
import { FRAME, createRequestId, decodeFrame, encodeFrame, isRequestId, sendWs, writeStream } from "@http-tunnel/shared/stream-protocol";

loadEnvFile(".env.server");

const listenConfig = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 12400),
  corsOrigins: envList("CORS_ORIGINS"),
  trustProxy: envBoolean("TRUST_PROXY"),
  secureCookies: envBoolean("SECURE_COOKIES"),
  sessionTtlMs: envPositiveInteger("SESSION_TTL_MS", 12 * 60 * 60 * 1000),
  maxSessions: envPositiveInteger("MAX_SESSIONS", 1000),
  maxConcurrentRequests: envPositiveInteger("MAX_CONCURRENT_REQUESTS", 256),
  maxConcurrentRequestsPerMapping: envPositiveInteger("MAX_CONCURRENT_REQUESTS_PER_MAPPING", 64),
  maxWsPayloadBytes: envPositiveInteger("MAX_WS_PAYLOAD_BYTES", 2 * 1024 * 1024),
  maxHeaderBytes: envPositiveInteger("MAX_HEADER_BYTES", 16 * 1024)
};
const config = {
  ...listenConfig,
  ...loadSettings(),
  loginRateLimiter: createLoginRateLimiter({ trustProxy: listenConfig.trustProxy }),
  audit(event, data = {}, req) {
    const actor = data.username || currentUser(req, config) || "";
    addAuditLog(event, { actor, ip: data.ip || (req ? clientIp(req, config.trustProxy) : ""), data });
  },
  upgradePassword(password) {
    Object.assign(config, saveSettings({ ...publicConfig(), adminPassword: hashPassword(password) }));
  }
};
ensureAdmin(config);

const logger = createLogger("server");
const WS_OPEN = 1;
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
  if (!isClientConnected()) return "disconnected";
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

async function sendMappingStatus(ws = client) {
  if (!ws || ws.readyState !== WS_OPEN || client !== ws || isClientHeartbeatTimedOut(ws)) return false;
  const sent = await sendWs(ws, JSON.stringify({ type: "mapping-status", mappings: mappingStatusPayload() }));
  if (sent) markClientActivity(ws);
  return sent;
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
  const server = http.createServer({ maxHeaderSize: config.maxHeaderBytes }, (req, res) => handleMappedRequest(mapping, req, res));
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

function clearClientHeartbeat(ws) {
  clearInterval(ws.heartbeatInterval);
  clearTimeout(ws.heartbeatTimeoutTimer);
  ws.heartbeatInterval = null;
  ws.heartbeatTimeoutTimer = null;
  ws.awaitingPong = false;
}

function isClientHeartbeatTimedOut(ws = client) {
  return Boolean(
    ws?.lastHeartbeatMonotonicAt &&
    performance.now() - ws.lastHeartbeatMonotonicAt >= TUNNEL_HEARTBEAT_STALE_MS
  );
}

function isClientConnected(ws = client) {
  return Boolean(ws && ws.readyState === WS_OPEN && !isClientHeartbeatTimedOut(ws));
}

function startClientHeartbeat(ws = client) {
  if (!ws || ws.readyState !== WS_OPEN || client !== ws) return;
  clearInterval(ws.heartbeatInterval);
  ws.heartbeatInterval = setInterval(() => sendClientHeartbeat(ws), TUNNEL_HEARTBEAT_INTERVAL_MS);
  ws.heartbeatInterval.unref?.();
  scheduleClientHeartbeatTimeout(ws);
  sendClientHeartbeat(ws);
}

function recoverHeartbeatAfterLoopPause(ws) {
  const now = performance.now();
  const loopElapsedMs = now - ws.lastHeartbeatLoopAt;
  ws.lastHeartbeatLoopAt = now;
  if (
    loopElapsedMs < TUNNEL_HEARTBEAT_INTERVAL_MS + TUNNEL_HEARTBEAT_LOOP_LAG_MS ||
    !isClientHeartbeatTimedOut(ws)
  ) {
    return false;
  }

  ws.lastHeartbeatMonotonicAt = now - TUNNEL_HEARTBEAT_STALE_MS + TUNNEL_HEARTBEAT_RECOVERY_MS;
  logger.warn("heartbeat check resumed after local event loop pause", {
    clientId: ws.clientId,
    loopElapsedMs: Math.round(loopElapsedMs),
    recoveryMs: TUNNEL_HEARTBEAT_RECOVERY_MS
  });
  scheduleClientHeartbeatTimeout(ws);
  return true;
}

function markClientActivity(ws = client) {
  if (!ws || ws.readyState !== WS_OPEN || client !== ws) return;
  ws.lastActivityAt = new Date().toISOString();
}

function sendClientHeartbeat(ws) {
  if (!ws || ws.readyState !== WS_OPEN || client !== ws) return;
  const recoveredFromLoopPause = recoverHeartbeatAfterLoopPause(ws);
  if (isClientHeartbeatTimedOut(ws) && !recoveredFromLoopPause) {
    logger.warn("client heartbeat timed out", {
      clientId: ws.clientId,
      lastHeartbeatAt: ws.lastHeartbeatAt ? new Date(ws.lastHeartbeatAt).toISOString() : "",
      timeoutMs: TUNNEL_HEARTBEAT_STALE_MS,
      pending: pending.size,
      bufferedAmount: ws.bufferedAmount
    });
    ws.terminate();
    return;
  }
  const sentAt = Date.now();
  ws.awaitingPong = true;
  ws.lastPingAt = sentAt;
  ws.lastPingAtIso = new Date(sentAt).toISOString();

  try {
    ws.ping(String(sentAt), (error) => {
      if (error && client === ws) {
        logger.warn("client heartbeat ping failed", { clientId: ws.clientId, error: error.message });
        ws.terminate();
      }
    });
  } catch (error) {
    logger.warn("client heartbeat ping failed", { clientId: ws.clientId, error: error.message });
    ws.terminate();
  }
}

function scheduleClientHeartbeatTimeout(ws) {
  clearTimeout(ws.heartbeatTimeoutTimer);
  const elapsedMs = performance.now() - ws.lastHeartbeatMonotonicAt;
  const remainingMs = Math.max(1, TUNNEL_HEARTBEAT_STALE_MS - elapsedMs);
  ws.heartbeatTimeoutTimer = setTimeout(() => {
    if (ws.readyState !== WS_OPEN || client !== ws) return;
    if (recoverHeartbeatAfterLoopPause(ws)) {
      sendClientHeartbeat(ws);
      return;
    }
    if (!isClientHeartbeatTimedOut(ws)) {
      scheduleClientHeartbeatTimeout(ws);
      return;
    }
    logger.warn("client heartbeat timed out", {
      clientId: ws.clientId,
      lastHeartbeatAt: ws.lastHeartbeatAt ? new Date(ws.lastHeartbeatAt).toISOString() : "",
      timeoutMs: TUNNEL_HEARTBEAT_STALE_MS,
      pending: pending.size,
      bufferedAmount: ws.bufferedAmount
    });
    ws.terminate();
  }, remainingMs);
  ws.heartbeatTimeoutTimer.unref?.();
}

async function sendToClient(payload) {
  if (!isClientConnected()) return false;
  const sent = await sendWs(client, JSON.stringify(payload));
  if (sent) markClientActivity(client);
  return sent;
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

function failHttpResponse(res, statusCode, errorMessage) {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
    res.end(errorMessage);
    return;
  }
  res.destroy(new Error(errorMessage));
}

function cancelClientRequest(id, errorMessage) {
  void sendToClient({ type: "request-error", id, error: errorMessage });
}

function createIdleTimer(id, res) {
  const timeout = () => {
    const item = finishPending(id, "tunnel request idle timed out");
    if (!item) return;
    cancelClientRequest(id, "tunnel request idle timed out");
    failHttpResponse(res, 504, "tunnel request idle timed out");
    logger.warn("tunnel request idle timed out", {
      clientId: isClientConnected() ? client.clientId : "",
      requestId: id,
      mappingId: item.mappingId
    });
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
  if (!isClientConnected()) {
    json(res, 502, { ok: false, error: "client is not connected" });
    return;
  }

  const stats = statsFor(mapping.id);
  stats.requestCount += 1;
  stats.lastAccessAt = new Date().toISOString();
  if (
    pending.size >= config.maxConcurrentRequests ||
    stats.activeRequests >= config.maxConcurrentRequestsPerMapping
  ) {
    stats.errorCount += 1;
    json(res, 503, { ok: false, error: "tunnel concurrency limit reached" });
    return;
  }

  const id = createRequestId();
  stats.activeRequests += 1;
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
    if (!pending.has(id)) {
      req.destroy();
      return;
    }
    pending.get(id)?.resetTimer();
    stats.bytesIn += chunk.length;
    if (!(await sendToClientBinary(encodeFrame(FRAME.REQUEST_BODY, id, chunk)))) {
      const item = finishPending(id, "client is not connected");
      if (item) failHttpResponse(item.res, 502, "client is not connected");
      req.destroy();
      return;
    }
    req.resume();
  });
  req.on("end", () => {
    if (!pending.has(id)) return;
    pending.get(id)?.resetTimer();
    void sendToClient({ type: "request-end", id });
  });
  req.on("error", (error) => {
    if (!pending.has(id)) return;
    pending.get(id)?.resetTimer();
    cancelClientRequest(id, error.message);
  });
  res.on("close", () => {
    if (!pending.has(id) || res.writableEnded) return;
    finishPending(id, "downstream response closed");
    cancelClientRequest(id, "downstream response closed");
  });
}

async function sendToClientBinary(payload) {
  if (!isClientConnected()) return false;
  const sent = await sendWs(client, payload, { binary: true });
  if (sent) markClientActivity(client);
  return sent;
}

function startResponse(payload) {
  const item = pending.get(payload.id);
  if (!item) return;
  item.resetTimer();

  if (payload.error) {
    finishPending(payload.id, payload.error);
    failHttpResponse(item.res, 502, payload.error);
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
    if (!pending.has(id)) return;
    statsFor(item.mappingId).bytesOut += chunk.length;
    if (!(await writeStream(item.res, chunk))) {
      finishPending(id, "downstream response closed");
      cancelClientRequest(id, "downstream response closed");
    }
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
  finishPending(payload.id, payload.error || "");
  if (payload.error) failHttpResponse(item.res, 502, payload.error);
  else item.res.end();
}

function failPending(error) {
  for (const [id, item] of pending.entries()) {
    if (!item.res.writableEnded) {
      failHttpResponse(item.res, 502, error);
    }
    finishPending(id, error);
  }
}

function statusPayload(req) {
  return {
    ok: true,
    app: "server",
    user: currentUser(req, config) ? { username: config.adminUser } : null,
    client: isClientConnected() ? {
      id: client.clientId,
      connectedAt: client.connectedAt,
      latencyMs: client.latencyMs ?? null,
      lastPingAt: client.lastPingAtIso || "",
      lastPongAt: client.lastPongAt || "",
      lastHeartbeatAt: client.lastHeartbeatAt ? new Date(client.lastHeartbeatAt).toISOString() : "",
      lastActivityAt: client.lastActivityAt || ""
    } : null,
    mappings: mappings.map((mapping) => ({ ...mapping, status: mappingStatus(mapping), statusMessage: mappingStatusMessage(mapping), stats: updateRates(statsFor(mapping.id)) })),
    pending: pending.size,
    limits: {
      maxConcurrentRequests: config.maxConcurrentRequests,
      maxConcurrentRequestsPerMapping: config.maxConcurrentRequestsPerMapping,
      maxWsPayloadBytes: config.maxWsPayloadBytes
    },
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
    addAuditLog("server_configured", { actor: body.adminUser, ip: clientIp(req, config.trustProxy), data: { baseUrl: config.baseUrl, tunnelToken: redact(config.tunnelToken) } });
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
    addAuditLog("server_config_updated", { actor, ip: clientIp(req, config.trustProxy), data: { baseUrl: config.baseUrl, tunnelToken: redact(config.tunnelToken) } });
    json(res, 200, { ok: true, config: publicConfig(), ...result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
}

const server = http.createServer({ maxHeaderSize: config.maxHeaderBytes }, async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (applyCors(req, res, { allowedOrigins: config.corsOrigins })) return;
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

  json(res, 404, { ok: false, error: "not found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsPayloadBytes, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/_tunnel/ws") {
    socket.destroy();
    return;
  }

  const clientId = url.searchParams.get("clientId") || "";
  const rejectTunnel = (statusCode, statusText, event, data = {}) => {
    addAuditLog(event, { ip: clientIp(req, config.trustProxy), data: { clientId, ...data } });
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

  if (clientUpgradeInProgress) {
    rejectTunnel(409, "Conflict", "tunnel_client_rejected", { reason: "client already connected" });
    return;
  }
  if (client && client.readyState === WS_OPEN) {
    if (isClientConnected()) {
      rejectTunnel(409, "Conflict", "tunnel_client_rejected", { reason: "client already connected" });
      return;
    }
    logger.warn("replacing stale client connection", { clientId: client.clientId });
    client.terminate();
    client = null;
  }

  clientUpgradeInProgress = true;
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.clientId = clientId || "client";
      ws.connectedAt = new Date().toISOString();
      ws.awaitingPong = false;
      ws.lastPongAt = "";
      ws.lastHeartbeatAt = Date.now();
      ws.lastHeartbeatMonotonicAt = performance.now();
      ws.lastHeartbeatLoopAt = performance.now();
      ws.lastPingAt = 0;
      ws.lastPingAtIso = "";
      ws.lastActivityAt = "";
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
  markClientActivity(ws);
  startClientHeartbeat(ws);
  logger.info("client connected", { clientId: ws.clientId });
  addAuditLog("client_connected", { actor: ws.clientId, data: { clientId: ws.clientId } });

  ws.on("pong", (payload) => {
    if (client !== ws) return;
    markClientActivity(ws);
    ws.awaitingPong = false;
    clearTimeout(ws.heartbeatTimeoutTimer);
    ws.heartbeatTimeoutTimer = null;
    const sentAt = Number(payload.toString());
    if (Number.isFinite(sentAt)) ws.latencyMs = Date.now() - sentAt;
    ws.lastHeartbeatAt = Date.now();
    ws.lastHeartbeatMonotonicAt = performance.now();
    ws.lastPongAt = new Date(ws.lastHeartbeatAt).toISOString();
    scheduleClientHeartbeatTimeout(ws);
  });

  ws.on("message", (raw, isBinary) => {
    if (client !== ws) return;
    markClientActivity(ws);
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
    if (payload.type === "response-start" && isRequestId(payload.id)) startResponse(payload);
    if (payload.type === "response-end" && isRequestId(payload.id)) void endResponse(payload);
    if (payload.type === "response-error" && isRequestId(payload.id)) void endResponse(payload);
  });

  ws.on("error", (error) => {
    if (client !== ws) {
      logger.info("stale client connection error ignored", { error: error.message });
      return;
    }
    logger.warn("client connection error", { clientId: ws.clientId, error: error.message });
    ws.terminate();
  });

  ws.on("close", () => {
    const wasCurrent = client === ws;
    clearClientHeartbeat(ws);
    if (wasCurrent) {
      client = null;
      failPending("client disconnected");
      logger.warn("client disconnected", { clientId: ws.clientId });
      addAuditLog("client_disconnected", { actor: ws.clientId, data: { clientId: ws.clientId } });
    } else {
      logger.info("stale client connection closed", { clientId: ws.clientId });
    }
  });
});

server.listen(listenConfig.port, listenConfig.host, () => {
  logger.info("server listening", { host: listenConfig.host, port: listenConfig.port });
});
