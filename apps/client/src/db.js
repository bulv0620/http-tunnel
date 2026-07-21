import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { normalizeBaseUrl } from "@http-tunnel/shared/base-url";
import { normalizeMappings } from "@http-tunnel/shared/mappings";
import { hashPassword, isPasswordHash } from "@http-tunnel/shared/password";
import { validateBaseUrl, validatePositiveNumber, validateServerUrl, validateToken } from "@http-tunnel/shared/validators";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(currentDir, "..", "db");
const dbPath = path.join(dbDir, "client.sqlite");

const defaults = {
  baseUrl: "/",
  adminUser: "",
  adminPassword: "",
  serverUrl: "ws://127.0.0.1:12400/_tunnel/ws",
  tunnelToken: "",
  clientId: "client",
  reconnectMs: 3000,
  requestTimeoutMs: 30000,
  maxResponseBytes: 65536
};

fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mappings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    server_port INTEGER NOT NULL,
    client_host TEXT NOT NULL,
    client_port INTEGER NOT NULL,
    access_mode TEXT NOT NULL DEFAULT 'direct',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const mappingColumns = db.prepare("PRAGMA table_info(mappings)").all();
if (!mappingColumns.some((column) => column.name === "access_mode")) {
  db.exec("ALTER TABLE mappings ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'direct'");
}

const readAll = db.prepare("SELECT key, value FROM settings");
const upsert = db.prepare(`
  INSERT INTO settings (key, value)
  VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const readMappings = db.prepare(`
  SELECT id, name, server_port AS serverPort, client_host AS clientHost, client_port AS clientPort,
         access_mode AS accessMode, enabled
  FROM mappings
  ORDER BY created_at ASC
`);
const insertMapping = db.prepare(`
  INSERT INTO mappings (id, name, server_port, client_host, client_port, access_mode, enabled)
  VALUES (@id, @name, @serverPort, @clientHost, @clientPort, @accessMode, @enabled)
`);
const updateMappingRow = db.prepare(`
  UPDATE mappings
  SET name = @name,
      server_port = @serverPort,
      client_host = @clientHost,
      client_port = @clientPort,
      access_mode = @accessMode,
      enabled = @enabled,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);
const deleteMappingRow = db.prepare("DELETE FROM mappings WHERE id = ?");

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
  output.reconnectMs = numberValue(output.reconnectMs, defaults.reconnectMs);
  output.requestTimeoutMs = numberValue(output.requestTimeoutMs, defaults.requestTimeoutMs);
  output.maxResponseBytes = numberValue(output.maxResponseBytes, defaults.maxResponseBytes);
  return output;
}

export function saveSettings(input) {
  const password = String(input.adminPassword || "");
  const next = {
    baseUrl: validateBaseUrl(input.baseUrl),
    adminUser: String(input.adminUser || "").trim(),
    adminPassword: password && isPasswordHash(password) ? password : hashPassword(password),
    serverUrl: validateServerUrl(input.serverUrl || defaults.serverUrl),
    tunnelToken: validateToken(input.tunnelToken),
    clientId: String(input.clientId || defaults.clientId).trim(),
    reconnectMs: validatePositiveNumber(input.reconnectMs, "reconnectMs", defaults.reconnectMs),
    requestTimeoutMs: validatePositiveNumber(input.requestTimeoutMs, "requestTimeoutMs", defaults.requestTimeoutMs),
    maxResponseBytes: validatePositiveNumber(input.maxResponseBytes, "adminApiMaxBodyBytes", defaults.maxResponseBytes)
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

export function listMappings() {
  return normalizeMappings(readMappings.all().map((row) => ({ ...row, enabled: Boolean(row.enabled) })));
}

export function createMapping(mapping) {
  const [normalized] = normalizeMappings([{ ...mapping, id: mapping.id }]);
  insertMapping.run({ ...normalized, enabled: normalized.enabled ? 1 : 0 });
  return normalized;
}

export function updateMapping(id, mapping) {
  const [normalized] = normalizeMappings([{ ...mapping, id }]);
  if (!normalized) return null;
  const result = updateMappingRow.run({ ...normalized, enabled: normalized.enabled ? 1 : 0 });
  return result.changes ? normalized : null;
}

export function deleteMapping(id) {
  return deleteMappingRow.run(id).changes > 0;
}
