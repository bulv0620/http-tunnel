export function normalizeBaseUrl(value = "/") {
  const trimmed = String(value || "/").trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function stripBaseUrl(pathname, baseUrl) {
  if (baseUrl === "/") return pathname;
  if (pathname === baseUrl) return "/";
  if (pathname.startsWith(`${baseUrl}/`)) return pathname.slice(baseUrl.length) || "/";
  return null;
}
