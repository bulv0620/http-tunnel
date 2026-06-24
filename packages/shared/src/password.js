import crypto from "node:crypto";

const PREFIX = "pbkdf2_sha256";
const ITERATIONS = 160000;
const KEY_LENGTH = 32;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEY_LENGTH, "sha256").toString("hex");
  return `${PREFIX}$${ITERATIONS}$${salt}$${hash}`;
}

export function isPasswordHash(value) {
  return String(value || "").startsWith(`${PREFIX}$`);
}

export function verifyPassword(password, stored) {
  const value = String(stored || "");
  if (!isPasswordHash(value)) return password === value;

  const [, iterations, salt, expected] = value.split("$");
  if (!iterations || !salt || !expected) return false;
  const candidate = crypto.pbkdf2Sync(String(password), salt, Number(iterations), KEY_LENGTH, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"));
}
