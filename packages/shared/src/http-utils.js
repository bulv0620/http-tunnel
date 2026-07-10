const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const FETCH_DECODED_HEADERS = new Set([
  "content-encoding",
  "content-length"
]);

export function toHeaderObject(headers) {
  const output = {};
  const connectionHeaders = new Set(
    String(headers.connection || "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || connectionHeaders.has(key)) continue;
    if (key.startsWith("sec-websocket-")) continue;
    if (typeof value === "undefined") continue;
    output[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return output;
}

export function headersFromFetch(fetchHeaders) {
  const output = {};
  for (const [name, value] of fetchHeaders.entries()) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (FETCH_DECODED_HEADERS.has(key)) continue;
    output[key] = value;
  }
  return output;
}

export function readBody(stream, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`body is larger than ${maxBytes} bytes`));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function readJson(req, maxBytes) {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  return JSON.parse(body.toString());
}

export function json(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length
  });
  res.end(body);
}

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}
