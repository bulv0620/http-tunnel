import crypto from "node:crypto";
import { readJson, json } from "./http-utils.js";
import { isPasswordHash, verifyPassword } from "./password.js";
import { clientIp } from "./audit.js";

const sessions = new Map();

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
  return session?.user === config.adminUser ? session.user : null;
}

export function requireAuth(req, res, config) {
  if (currentUser(req, config)) return true;
  json(res, 401, { ok: false, error: "unauthorized" });
  return false;
}

export function createLoginRateLimiter({ maxFailures = 5, windowMs = 5 * 60 * 1000, lockMs = 5 * 60 * 1000 } = {}) {
  const buckets = new Map();

  function bucketFor(key) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.firstFailureAt > windowMs) {
      const next = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
      buckets.set(key, next);
      return next;
    }
    return bucket;
  }

  return {
    check(req) {
      const key = clientIp(req);
      const bucket = bucketFor(key);
      return { allowed: Date.now() >= bucket.lockedUntil, key, lockedUntil: bucket.lockedUntil };
    },
    success(req) {
      buckets.delete(clientIp(req));
    },
    failure(req) {
      const key = clientIp(req);
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
    config.audit?.("login_failed", { username: body.username, ip: failure?.key || clientIp(req), failures: failure?.failures || 1 }, req);
    json(res, 401, { ok: false, error: "invalid username or password" });
    return;
  }
  config.loginRateLimiter?.success(req);
  config.audit?.("login_success", { username: config.adminUser, ip: clientIp(req) }, req);
  if (!isPasswordHash(config.adminPassword)) config.upgradePassword?.(body.password || "");
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { user: config.adminUser, createdAt: Date.now() });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`
  });
  res.end(JSON.stringify({ ok: true, user: { username: config.adminUser } }));
}

export function logout(req, res) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) sessions.delete(sid);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  });
  res.end(JSON.stringify({ ok: true }));
}
