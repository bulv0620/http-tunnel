import crypto from "node:crypto";
import { readJson, json } from "./http-utils.js";
import { isPasswordHash, verifyPassword } from "./password.js";
import { clientIp } from "./audit.js";

const sessions = new Map();
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;
const MAX_RATE_LIMIT_BUCKETS = 10000;

function parseCookies(header = "") {
  const output = {};
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    output[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return output;
}

export function ensureAdmin(config) {
  config.adminUser ||= "admin";
  config.adminPassword ||= "";
}

export function currentUser(req, config) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  const sessionTtlMs = config.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  if (session && Date.now() - session.createdAt >= sessionTtlMs) {
    sessions.delete(sid);
    return null;
  }
  return session?.user === config.adminUser ? session.user : null;
}

export function requireAuth(req, res, config) {
  if (currentUser(req, config)) return true;
  json(res, 401, { ok: false, error: "unauthorized" });
  return false;
}

export function createLoginRateLimiter({ maxFailures = 5, windowMs = 5 * 60 * 1000, lockMs = 5 * 60 * 1000, trustProxy = false } = {}) {
  const buckets = new Map();

  function bucketFor(key) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.firstFailureAt > windowMs) {
      const next = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
      if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) buckets.delete(buckets.keys().next().value);
      buckets.set(key, next);
      return next;
    }
    return bucket;
  }

  return {
    check(req) {
      const key = clientIp(req, trustProxy);
      const bucket = bucketFor(key);
      return { allowed: Date.now() >= bucket.lockedUntil, key, lockedUntil: bucket.lockedUntil };
    },
    success(req) {
      buckets.delete(clientIp(req, trustProxy));
    },
    failure(req) {
      const key = clientIp(req, trustProxy);
      const bucket = bucketFor(key);
      bucket.failures += 1;
      if (bucket.failures >= maxFailures) bucket.lockedUntil = Date.now() + lockMs;
      return { key, failures: bucket.failures, lockedUntil: bucket.lockedUntil };
    }
  };
}

export async function login(req, res, config) {
  const body = await readJson(req, 1024 * 32);
  const rate = config.loginRateLimiter?.check(req);
  if (rate && !rate.allowed) {
    config.audit?.("login_locked", { username: body.username, ip: rate.key, lockedUntil: new Date(rate.lockedUntil).toISOString() }, req);
    json(res, 429, { ok: false, error: "too many login attempts" });
    return;
  }

  if (body.username !== config.adminUser || !verifyPassword(body.password || "", config.adminPassword)) {
    const failure = config.loginRateLimiter?.failure(req);
    config.audit?.("login_failed", { username: body.username, ip: failure?.key || clientIp(req, config.trustProxy), failures: failure?.failures || 1 }, req);
    json(res, 401, { ok: false, error: "invalid username or password" });
    return;
  }
  config.loginRateLimiter?.success(req);
  config.audit?.("login_success", { username: config.adminUser, ip: clientIp(req, config.trustProxy) }, req);
  if (!isPasswordHash(config.adminPassword)) config.upgradePassword?.(body.password || "");
  const now = Date.now();
  const sessionTtlMs = config.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  for (const [existingSid, session] of sessions.entries()) {
    if (now - session.createdAt >= sessionTtlMs) sessions.delete(existingSid);
  }
  const maxSessions = config.maxSessions || DEFAULT_MAX_SESSIONS;
  while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { user: config.adminUser, createdAt: now });
  const forwardedHttps = config.trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  const secure = config.secureCookies || req.socket?.encrypted || forwardedHttps;
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`
  });
  res.end(JSON.stringify({ ok: true, user: { username: config.adminUser } }));
}

export function logout(req, res, config = {}) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) sessions.delete(sid);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${config.secureCookies ? "; Secure" : ""}`
  });
  res.end(JSON.stringify({ ok: true }));
}

export function clearSessions() {
  sessions.clear();
}
