export function validatePort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

export function validateBaseUrl(value = "/") {
  const raw = String(value || "/").trim();
  if (raw === "/") return "/";
  if (!raw.startsWith("/")) throw new Error("baseUrl must start with /");
  if (raw.includes("?") || raw.includes("#")) throw new Error("baseUrl cannot include query or hash");
  const normalized = `/${raw.replace(/^\/+|\/+$/g, "")}`;
  if (normalized === "/_tunnel" || normalized.startsWith("/_tunnel/")) {
    throw new Error("baseUrl cannot use the tunnel path");
  }
  return normalized;
}

export function validateToken(value) {
  const token = String(value || "");
  if (token && token.length < 12) throw new Error("tunnel token must be at least 12 characters");
  return token;
}

export function validatePositiveNumber(value, label, fallback) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than 0`);
  return number;
}

export function validateServerUrl(value) {
  const raw = String(value || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("serverUrl must be a valid ws:// or wss:// URL");
  }
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("serverUrl must use ws:// or wss://");
  if (url.pathname !== "/_tunnel/ws") throw new Error("serverUrl path must be /_tunnel/ws");
  return url.toString();
}
