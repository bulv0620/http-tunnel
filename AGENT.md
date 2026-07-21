# Agent Summary

This document is for future coding agents taking over this repository.

## Project Overview

`http-tunnel` is a Node.js monorepo for HTTP reverse tunneling.

The system has three apps and one shared package:

```text
apps/web       Vue 3 + Element Plus SPA
apps/server    Public tunnel server and admin API
apps/client    Local tunnel client and admin API
packages/shared Shared server/client utilities
```

The server accepts public HTTP requests on mapped ports, forwards them through one Socket.IO tunnel (WebSocket transport only) to the client, and the client streams the request to a local HTTP service. Responses are streamed back through the same tunnel.

The project intentionally supports only:

- one connected client per server
- one server connection per client
- client-controlled port mappings
- read-only mapping display on the server dashboard

## Runtime Defaults

Server:

```text
HOST=0.0.0.0
PORT=12400
```

Client:

```text
ADMIN_HOST=0.0.0.0
ADMIN_PORT=12500
```

Local env files exist:

```text
.env.server
.env.client
.env.web
```

Business settings are stored in SQLite after first-run setup. Operational security and resource limits are environment-driven:

```text
CORS_ORIGINS                         empty; same-origin only
TRUST_PROXY                          false
SECURE_COOKIES                       false
SESSION_TTL_MS                       43200000
MAX_SESSIONS                         1000
MAX_CONCURRENT_REQUESTS              256
MAX_CONCURRENT_REQUESTS_PER_MAPPING  64
MAX_WS_PAYLOAD_BYTES                 2097152
MAX_HEADER_BYTES                     16384
MAX_RECONNECT_DELAY_MS                15000
```

Environment parsing is centralized in `packages/shared/src/runtime-config.js` and fails fast for invalid booleans or positive integers.

## Data Storage

SQLite paths:

```text
apps/server/db/server.sqlite
apps/client/db/client.sqlite
```

These files are ignored by git.

The app creates the `db` directories automatically on startup.

Client mappings are stored in the `mappings` table. Each mapping has an `access_mode` column with these persisted values:

```text
direct
reverse-proxy
```

`apps/client/src/db.js` migrates existing databases by adding `access_mode TEXT NOT NULL DEFAULT 'direct'` when the column is missing. Keep this migration and default so mappings created before access modes existed retain their original public-listener behavior.

All provided Docker compose files bind-mount the corresponding host DB directory:

```text
../../db/server -> /app/apps/server/db
../../db/client -> /app/apps/client/db
```

Recreating a container therefore preserves setup state. To reset setup, stop the container and explicitly remove the corresponding host DB directory/file.

## Web App

The frontend is a Vue 3 SPA with Element Plus.

Important files:

```text
apps/web/src/router.js
apps/web/src/store.js
apps/web/src/api/client.js
apps/web/src/i18n.js
apps/web/src/style.css
apps/web/src/views/LoginView.vue
apps/web/src/views/SetupView.vue
apps/web/src/views/ServerDashboard.vue
apps/web/src/views/ClientDashboard.vue
apps/web/src/views/ServerConfig.vue
apps/web/src/views/ClientConfig.vue
apps/web/src/views/AppShell.vue
apps/web/src/views/DashboardView.vue
apps/web/src/views/ConfigView.vue
```

The frontend is built with:

```bash
npm run build:web
```

After build, server/client host the built assets from `apps/web/dist`.

If assets are missing, server/client return:

```json
{"ok":false,"error":"web assets not built"}
```

The web UI has a lightweight i18n layer in `apps/web/src/i18n.js`.

Current locales:

```text
en
zh-CN
```

The selected locale is stored in localStorage under:

```text
http-tunnel.locale
```

When adding or changing user-facing frontend text, update both locale dictionaries and use `t("...")` in Vue components instead of hard-coded labels/messages. Existing login, setup, config, shell, and dashboard screens follow this pattern.

The frontend visual system is mostly centralized in `apps/web/src/style.css`. It uses a responsive control-center style with sticky top navigation, metric cards, connection summaries, status pills, compact log lists, and responsive tables. Prefer extending the existing classes and CSS variables over adding one-off component styling.

The client mapping dialog in `apps/web/src/views/DashboardView.vue` lets users choose between direct access and reverse-proxy access. It must always present a clear default and helper text; an absent `accessMode` is displayed and submitted as `direct` for backward compatibility.

## Auth And Setup

Both server and client keep login.

First run:

- visiting the admin URL shows setup
- setup saves admin credentials and tunnel config into SQLite
- passwords are hashed before being stored

Both server and client have login failure rate limiting in shared auth code. Sessions have a 12-hour default lifetime and a default maximum of 1000 entries. The oldest session is removed when the cap is reached.

Admin HTTP security rules:

- CORS is same-origin by default; cross-origin admin frontends must be explicitly listed in `CORS_ORIGINS`.
- Never restore reflective arbitrary-origin CORS with credentials.
- `X-Forwarded-For` and `X-Forwarded-Proto` are ignored unless `TRUST_PROXY=true`.
- Enable `TRUST_PROXY` only when direct access is blocked and a trusted proxy sanitizes forwarded headers.
- Session cookies are `HttpOnly` and `SameSite=Lax`; HTTPS requests automatically receive `Secure`, and `SECURE_COOKIES=true` can force it.

Relevant shared files:

```text
packages/shared/src/auth.js
packages/shared/src/password.js
packages/shared/src/validators.js
```

## Tunnel Auth

The client sends the tunnel token using an HTTP header:

```text
Authorization: Bearer <token>
```

The server still has backward-compatible fallback for `?token=...`.

Server tunnel authentication is intentionally strict:

- the server must be fully initialized before accepting Socket.IO tunnel handshakes
- the server tunnel token is required and cannot be empty
- a bad tunnel token must fail the Socket.IO handshake with `401`
- if one client is already connected, another client must be rejected instead of replacing it
- when the server tunnel token changes, the existing tunnel connection must be closed so the client has to re-authenticate immediately

This protects the intended one-server-to-one-client model. Do not reintroduce behavior where an unconfigured server accepts tunnel connections, where an empty token disables auth, or where a newer client silently replaces the active client.

## Transfer Model

The transfer path is:

```text
user -> server mapped port (directly or through a local reverse proxy) -> Socket.IO tunnel -> client -> local HTTP service
```

The current implementation uses streaming instead of buffering full files in memory.

Core files:

```text
apps/server/src/index.js
apps/client/src/index.js
packages/shared/src/stream-protocol.js
packages/shared/src/http-utils.js
```

## Mapping Access Modes

Mapping access mode is client-controlled, persisted in client SQLite, sent in the `hello`/`mappings` tunnel control payload, and normalized again by the server.

Supported values and server behavior:

```text
direct         listen on the configured server HOST (legacy behavior)
reverse-proxy  listen only on 127.0.0.1
```

The canonical constants and normalization helpers live in `packages/shared/src/mappings.js`. Missing or unknown access-mode values normalize to `direct` so old clients and saved mappings remain compatible. The client admin API separately rejects explicitly unsupported non-empty values.

Do not change `reverse-proxy` to listen on `0.0.0.0`; its purpose is to prevent the mapped port from being reachable through the server's public interfaces. Nginx, Caddy, or another proxy on the same network namespace should forward to `127.0.0.1:<serverPort>`.

The Socket.IO protocol uses object events for request/response metadata and binary events for body chunks. Binary messages keep a compact prefix that identifies direction and request id.

Protocol messages and frames validate the 32-hex-character request id. Socket.IO payloads default to a 2 MiB maximum and compression is disabled. Do not remove these checks without replacing them with equivalent resource protection.

`request-error` is also the cancellation message from the server to the client. When the public caller disconnects or a tunnel request times out, the client must destroy both the local `ClientRequest` and any active local response stream. If an error occurs after public response headers were sent, destroy the HTTP response instead of appending an error string to the response body; this makes truncation visible and avoids corrupting downloads.

Body streaming uses separate Socket.IO binary events. Sender-side transport backpressure and receiver-side HTTP backpressure are handled with:

```text
sendTunnelData()
writeStream()
```

from `packages/shared/src/tunnel-transport.js` and `packages/shared/src/stream-protocol.js`.

`sendTunnelData()` waits for the local Engine.IO `drain` event or Socket.IO disconnect; it does not wait for a remote per-chunk acknowledgement. Stream writes resolve on `drain`, `close`, or `error` so a closed destination cannot leave an unresolved promise.

## Connection Recovery

Socket.IO/Engine.IO owns transport heartbeat and reconnect behavior. The client enables infinite reconnect attempts with exponential backoff and jitter. The base delay is the saved `reconnectMs`; `MAX_RECONNECT_DELAY_MS` defaults to 15 seconds. There is no custom application heartbeat, ping/pong watchdog, or hand-written reconnect loop.

The tunnel still performs a business handshake: the client emits `hello` with its mappings and does not report the tunnel as verified until the server returns a valid control event such as `mapping-status`. Control events do not require acknowledgements. Request and response bodies use ordered binary events; request lifecycle cleanup still occurs on Socket.IO disconnect, without replay after reconnect.

## Timeout Semantics

`requestTimeoutMs` is an idle timeout, not a total request duration limit.

Large upload/download requests should continue as long as data keeps flowing. The timeout only fires when no request or response data moves for the configured duration.

An idle timeout fails and cancels only that request. It must not terminate an otherwise healthy tunnel. There is no request replay or resume after a tunnel disconnect.

Default:

```text
30000 ms
```

## Request Body Limits

The admin API body limit is intentionally small by default:

```text
65536 bytes
```

This setting is not a tunnel file size limit. It applies to JSON/admin API request bodies.

## Resource Limits

Both sides independently enforce global and per-mapping active-request limits. Defaults are 256 globally and 64 per mapping. The server returns `503` before creating tunnel state when its limit is reached; the client returns a `response-error` if its independent limit is reached.

HTTP header size defaults to 16 KiB and Socket.IO payload size defaults to 2 MiB. Hop-by-hop headers, including names nominated by the `Connection` header, are removed. Header arrays remain arrays so multiple `Set-Cookie` response headers are preserved.

## Observability

Implemented observability features:

- persistent server audit logs in SQLite
- client/server connection state
- Socket.IO connection and transport display
- mapping traffic counters
- real-time rate display
- active request count
- error count
- last access timestamp

Server audit log table is in `apps/server/src/db.js`.

## Docker

Docker files:

```text
Dockerfile
.dockerignore
deploy/docker/compose.server-host.yml
deploy/docker/compose.server-bridge.yml
deploy/docker/compose.client-host.yml
deploy/docker/compose.client-bridge.yml
```

Recommended server deployment:

```bash
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

Recommended client deployment:

```bash
docker compose -f deploy/docker/compose.client-host.yml up -d --build
```

Host network mode is preferred for:

- server dynamic mapped ports
- server reverse-proxy mappings consumed by Nginx/Caddy on the host
- client access to services running on the client host

Bridge mode exists, but server mapped ports must be manually exposed in `compose.server-bridge.yml`.

Reverse-proxy mappings bind to the server process's `127.0.0.1`. With Docker bridge networking, that loopback belongs to the container and is not reachable from a proxy on the host or in another container. Use PM2/direct execution or server host networking when the host reverse proxy needs to consume a `reverse-proxy` mapping.

Docker images copy project files into `/app`. The container does not live-sync with the host project directory. After code changes, rebuild:

```bash
git pull
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

Reset Docker state:

```bash
docker compose -f deploy/docker/compose.server-host.yml down
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

This recreates the container but preserves setup because the DB directory is bind-mounted. Remove the relevant host DB file only when an explicit setup reset is intended.

## Common Commands

Install:

```bash
npm install
```

Build frontend:

```bash
npm run build:web
```

Run server locally:

```bash
npm run dev:server
```

Run client locally:

```bash
npm run dev:client
```

Run web dev server:

```bash
npm run dev:web
```

PM2:

```bash
npm run pm2:server
npm run pm2:client
npm run pm2:start
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
npm run pm2:delete
```

Syntax check:

```bash
node --check apps/server/src/index.js
node --check apps/client/src/index.js
```

Shared security/protocol tests:

```bash
npm test
```

The current tests cover CORS, proxy trust, login/session security, header forwarding, mapping access-mode defaults/listen hosts, protocol validation, backpressure, and closed-stream behavior.

## Important Design Decisions

- Do not reintroduce EJS pages. The project has moved to separated frontend/backend.
- Frontend user-facing text should go through `apps/web/src/i18n.js`; keep `en` and `zh-CN` translations in sync.
- Keep the current Vue/Element Plus control-center UI style consistent. Prefer shared classes in `apps/web/src/style.css` over scattered per-view styling.
- Keep business settings in SQLite. Runtime-only security and resource controls belong in environment variables and should use `packages/shared/src/runtime-config.js` validation.
- Server dashboard must not edit mappings. Mappings are controlled by the client.
- Keep mapping access-mode compatibility: missing values default to `direct`, while `reverse-proxy` binds only to `127.0.0.1`.
- Client should not attempt to connect to the server before first-run setup is complete.
- Server tunnel access must remain authenticated and one-to-one. Reject extra clients; do not auto-replace the connected client.
- Docker DB bind mounts are intentional. Do not remove persistence or delete host DB state during routine rebuilds.
- README should describe the client as a generic client host, not as a NAS-specific service.

## Current Caveats

- There is no full automated end-to-end tunnel test yet; current automated coverage is at the shared security/protocol layer.
- Docker behavior is not part of the automated test suite.
- For public deployment behind Nginx or Cloudflare, upstream idle/read/send timeouts can still interrupt long uploads even though the app timeout is now idle-based.
- Socket.IO handshake fallback token in query string remains for compatibility but header auth is preferred.
