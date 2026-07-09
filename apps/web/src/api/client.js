let apiBase = "";
let unauthorizedHandler = null;

function envOrigin() {
  const raw = import.meta.env.DEV ? import.meta.env.VITE_API_BASE : "";
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

const API_ORIGIN = envOrigin();

export function setApiBase(baseUrl = "/") {
  apiBase = baseUrl === "/" ? "" : `/${String(baseUrl).replace(/^\/+|\/+$/g, "")}`;
}

export function currentBaseUrl() {
  return apiBase || "/";
}

export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

function target(path, options = {}) {
  if (options.root) return `${API_ORIGIN}${path}`;
  return `${API_ORIGIN}${apiBase}${path}`;
}

async function request(path, options = {}) {
  const response = await fetch(target(path, options), {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || "request failed" };
  }

  if (!response.ok) {
    const error = new Error(data.error || "request failed");
    error.status = response.status;
    if (response.status === 401 && !options.skipUnauthorizedHandler) {
      unauthorizedHandler?.(error);
    }
    throw error;
  }
  return data;
}

export const api = {
  setupStatus: () => request("/api/setup/status", { root: true }),
  setup: (payload) => request("/api/setup", { method: "POST", body: JSON.stringify(payload), root: true }),
  app: () => request("/api/app"),
  login: (payload) => request("/api/auth/login", { method: "POST", body: JSON.stringify(payload), skipUnauthorizedHandler: true }),
  logout: () => request("/api/auth/logout", { method: "POST", body: "{}", skipUnauthorizedHandler: true }),
  me: () => request("/api/auth/me"),
  status: () => request("/api/status"),
  config: () => request("/api/config"),
  saveConfig: (payload) => request("/api/config", { method: "PUT", body: JSON.stringify(payload) }),
  restartClient: () => request("/api/restart", { method: "POST", body: "{}" }),
  createMapping: (payload) => request("/api/mappings", { method: "POST", body: JSON.stringify(payload) }),
  updateMapping: (id, payload) => request(`/api/mappings/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteMapping: (id) => request(`/api/mappings/${id}`, { method: "DELETE" })
};
