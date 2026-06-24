import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { normalizeBaseUrl } from "@http-tunnel/shared/base-url";
import { hashPassword, isPasswordHash } from "@http-tunnel/shared/password";
import { validateBaseUrl, validatePositiveNumber, validateToken } from "@http-tunnel/shared/validators";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(currentDir, "..", "db");
const dbPath = path.join(dbDir, "server.sqlite");

const defaults = {
  baseUrl: "/",
  adminUser: "",
  adminPassword: "",
  tunnelToken: "",
  requestTimeoutMs: 30000,
  maxBodyBytes: 65536
};

fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event TEXT NOT NULL,
    actor TEXT,
    ip TEXT,
    data TEXT NOT NULL DEFAULT '{}'
  )
`);

const readAll = db.prepare("SELECT key, value FROM settings");
const upsert = db.prepare(`
  INSERT INTO settings (key, value)
  VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const insertAudit = db.prepare(`
  INSERT INTO audit_logs (time, event, actor, ip, data)
  VALUES (@time, @event, @actor, @ip, @data)
`);
const readAudit = db.prepare(`
  SELECT id, time, event, actor, ip, data
  FROM audit_logs
  ORDER BY id DESC
  LIMIT ?
`);

function numberValue(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

export function loadSettings() {
  const output = { ...defaults };
  for (const row of readAll.all()) {
    output[row.key] = row.value;
  }

  output.baseUrl = normalizeBaseUrl(output.baseUrl);
  output.requestTimeoutMs = numberValue(output.requestTimeoutMs, defaults.requestTimeoutMs);
  output.maxBodyBytes = numberValue(output.maxBodyBytes, defaults.maxBodyBytes);
  return output;
}

export function saveSettings(input) {
  const password = String(input.adminPassword || "");
  const next = {
    baseUrl: validateBaseUrl(input.baseUrl),
    adminUser: String(input.adminUser || "").trim(),
    adminPassword: password && isPasswordHash(password) ? password : hashPassword(password),
    tunnelToken: validateToken(input.tunnelToken),
    requestTimeoutMs: validatePositiveNumber(input.requestTimeoutMs, "requestTimeoutMs", defaults.requestTimeoutMs),
    maxBodyBytes: validatePositiveNumber(input.maxBodyBytes, "adminApiMaxBodyBytes", defaults.maxBodyBytes)
  };

  const write = db.transaction((settings) => {
    for (const [key, value] of Object.entries(settings)) {
      upsert.run({ key, value: String(value) });
    }
  });
  write(next);
  return loadSettings();
}

export function isConfigured(settings = loadSettings()) {
  return Boolean(settings.adminUser && settings.adminPassword);
}

export function addAuditLog(event, { actor = "", ip = "", data = {} } = {}) {
  insertAudit.run({
    time: new Date().toISOString(),
    event,
    actor,
    ip,
    data: JSON.stringify(data || {})
  });
}

export function listAuditLogs(limit = 100) {
  return readAudit.all(limit).map((row) => ({
    ...row,
    data: JSON.parse(row.data || "{}")
  }));
}
