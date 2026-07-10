function normalizedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isAllowedOrigin(req, origin, allowedOrigins) {
  const normalized = normalizedOrigin(origin);
  if (!normalized) return false;
  try {
    if (new URL(normalized).host === String(req.headers.host || "")) return true;
  } catch {
    return false;
  }
  return allowedOrigins.some((item) => normalizedOrigin(item) === normalized);
}

function rejectCors(res) {
  const body = Buffer.from(JSON.stringify({ ok: false, error: "origin is not allowed" }));
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length
  });
  res.end(body);
}

export function applyCors(req, res, { allowedOrigins = [] } = {}) {
  const origin = req.headers.origin;
  if (origin) {
    if (!isAllowedOrigin(req, origin, allowedOrigins)) {
      rejectCors(res);
      return true;
    }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
