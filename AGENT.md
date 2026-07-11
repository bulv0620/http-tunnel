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

The server accepts public HTTP requests on mapped ports, forwards them through one WebSocket tunnel to the client, and the client streams the request to a local HTTP service. Responses are streamed back through the same tunnel.

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
TUNNEL_PROBE_INTERVAL_MS              5000
TUNNEL_PROBE_TIMEOUT_MS               10000
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

- the server must be fully initialized before accepting tunnel WebSocket upgrades
- the server tunnel token is required and cannot be empty
- a bad tunnel token must fail the WebSocket upgrade with `401`
- if one client is already connected, another client must be rejected instead of replacing it
- when the server tunnel token changes, the existing tunnel connection must be closed so the client has to re-authenticate immediately

This protects the intended one-server-to-one-client model. Do not reintroduce behavior where an unconfigured server accepts tunnel connections, where an empty token disables auth, or where a newer client silently replaces the active client.

## Transfer Model

The transfer path is:

```text
user -> server mapped port -> WebSocket tunnel -> client -> local HTTP service
```

The current implementation uses streaming instead of buffering full files in memory.

Core files:

```text
apps/server/src/index.js
apps/client/src/index.js
packages/shared/src/stream-protocol.js
packages/shared/src/http-utils.js
```

The WebSocket protocol uses JSON messages for request/response metadata and binary messages for body chunks. Binary messages have a compact prefix that identifies direction and request id.

Protocol messages and frames validate the 32-hex-character request id. WebSocket payloads default to a 2 MiB maximum and compression is disabled. Do not remove these checks without replacing them with equivalent resource protection.

`request-error` is also the cancellation message from the server to the client. When the public caller disconnects or a tunnel request times out, the client must destroy both the local `ClientRequest` and any active local response stream. If an error occurs after public response headers were sent, destroy the HTTP response instead of appending an error string to the response body; this makes truncation visible and avoids corrupting downloads.

Backpressure is handled with:

```text
sendWs()
waitForWsBackpressure()
writeStream()
```

from `packages/shared/src/stream-protocol.js`.

Backpressure waiting has a 30-second ceiling. Stream writes resolve on `drain`, `close`, or `error` so a closed destination cannot leave an unresolved promise.

## Connection Recovery

The server sends a WebSocket ping every 15 seconds for transport latency. A tunnel is stale after 75 seconds without valid end-to-end client liveness. Valid inbound application messages (including `heartbeat` and response body frames) refresh server liveness; control ping/pong frames do not, because a CDN/proxy may terminate and answer them itself. This also means an active transfer is not disconnected merely because a control-frame pong is delayed.

The client also sends an end-to-end JSON `heartbeat` probe every 5 seconds. The server must return `heartbeat-ack`; the client terminates the socket if no acknowledgement or other valid server message arrives within 10 seconds after the probe is written. This application-level probe is intentional for CDN/proxy paths where a stale client-to-edge WebSocket can outlive the edge-to-origin connection. Do not replace it with only WebSocket control ping/pong.

New clients advertise `heartbeatVersion: 1` in `hello`, and new servers advertise it in `mapping-status`/`heartbeat-ack`. Before both sides negotiate this capability, the server lets pong refresh liveness and the client does not enforce the application-probe deadline, preserving rolling compatibility with older peers. After negotiation, only application messages refresh end-to-end liveness.

Heartbeat freshness uses the monotonic clock. If the local event loop resumes after a long pause, the peer gets a short 10-second fresh-probe window instead of an immediate stale disconnect. Preserve this distinction between peer failure and a local process pause.

The client reconnects forever. Reconnect delay starts at `reconnectMs`, uses exponential backoff with jitter, and defaults to a 15-second cap when the configured base is lower. Probe timeout and closure of a connection that was healthy for at least 30 seconds trigger one immediate reconnect; repeated setup/auth/connect failures still use backoff. A successful end-to-end verification or an explicit manual/config restart resets the retry state. Retry count, next retry time, end-to-end acknowledgement time, and probe latency are exposed by the client status API and dashboard.

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

HTTP header size defaults to 16 KiB and WebSocket payload size defaults to 2 MiB. Hop-by-hop headers, including names nominated by the `Connection` header, are removed. Header arrays remain arrays so multiple `Set-Cookie` response headers are preserved.

## Observability

Implemented observability features:

- persistent server audit logs in SQLite
- client/server connection state
- heartbeat and latency display
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
- client access to services running on the client host

Bridge mode exists, but server mapped ports must be manually exposed in `compose.server-bridge.yml`.

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

The current tests cover CORS, proxy trust, login/session security, header forwarding, protocol validation, backpressure, and closed-stream behavior.

## Important Design Decisions

- Do not reintroduce EJS pages. The project has moved to separated frontend/backend.
- Frontend user-facing text should go through `apps/web/src/i18n.js`; keep `en` and `zh-CN` translations in sync.
- Keep the current Vue/Element Plus control-center UI style consistent. Prefer shared classes in `apps/web/src/style.css` over scattered per-view styling.
- Keep business settings in SQLite. Runtime-only security and resource controls belong in environment variables and should use `packages/shared/src/runtime-config.js` validation.
- Server dashboard must not edit mappings. Mappings are controlled by the client.
- Client should not attempt to connect to the server before first-run setup is complete.
- Server tunnel access must remain authenticated and one-to-one. Reject extra clients; do not auto-replace the connected client.
- Docker DB bind mounts are intentional. Do not remove persistence or delete host DB state during routine rebuilds.
- README should describe the client as a generic client host, not as a NAS-specific service.

## Current Caveats

- There is no full automated end-to-end tunnel test yet; current automated coverage is at the shared security/protocol layer.
- Docker behavior is not part of the automated test suite.
- For public deployment behind Nginx or Cloudflare, upstream idle/read/send timeouts can still interrupt long uploads even though the app timeout is now idle-based.
- WebSocket fallback token in query string remains for compatibility but header auth is preferred.
