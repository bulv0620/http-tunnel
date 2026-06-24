import fs from "node:fs";
import path from "node:path";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function defaultDistDir() {
  return path.resolve(process.cwd(), "..", "web", "dist");
}

export function serveStaticWeb(req, res, distDir = process.env.WEB_DIST_DIR || defaultDistDir(), routedPathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(req.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(routedPathname || url.pathname);
  } catch {
    pathname = "/";
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(distDir, `.${requestedPath}`);

  if (!filePath.startsWith(path.resolve(distDir))) {
    return sendIndex(res, distDir, req.method);
  }

  fs.stat(filePath, (statError, stat) => {
    if (!statError && stat.isFile()) {
      sendFile(res, filePath, req.method);
      return;
    }
    sendIndex(res, distDir, req.method);
  });

  return true;
}

function sendIndex(res, distDir, method) {
  sendFile(res, path.join(distDir, "index.html"), method);
}

function sendFile(res, filePath, method) {
  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "web assets not built" }));
      return;
    }

    res.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    if (method === "HEAD") res.end();
    else res.end(body);
  });
}
