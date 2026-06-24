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
HOST=127.0.0.1
PORT=12400
```

Client:

```text
ADMIN_HOST=127.0.0.1
ADMIN_PORT=12500
```

Local env files exist:

```text
.env.server
.env.client
.env.web
```

Current design keeps env usage minimal. Business settings are stored in SQLite after first-run setup.

## Data Storage

SQLite paths:

```text
apps/server/db/server.sqlite
apps/client/db/client.sqlite
```

These files are ignored by git.

The app creates the `db` directories automatically on startup.

Docker compose currently does not mount database volumes by default. This is intentional: deleting and recreating a container resets setup state. If persistence is required later, add a compose volume manually.

## Web App

The frontend is a Vue 3 SPA with Element Plus.

Important files:

```text
apps/web/src/router.js
apps/web/src/store.js
apps/web/src/api/client.js
apps/web/src/views/LoginView.vue
apps/web/src/views/SetupView.vue
apps/web/src/views/ServerDashboard.vue
apps/web/src/views/ClientDashboard.vue
apps/web/src/views/ServerConfig.vue
apps/web/src/views/ClientConfig.vue
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

## Auth And Setup

Both server and client keep login.

First run:

- visiting the admin URL shows setup
- setup saves admin credentials and tunnel config into SQLite
- passwords are hashed before being stored

The server has login failure rate limiting in shared auth code.

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

Backpressure is handled with:

```text
sendWs()
waitForWsBackpressure()
writeStream()
```

from `packages/shared/src/stream-protocol.js`.

## Timeout Semantics

`requestTimeoutMs` is an idle timeout, not a total request duration limit.

Large upload/download requests should continue as long as data keeps flowing. The timeout only fires when no request or response data moves for the configured duration.

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

Because compose does not mount a DB volume by default, this resets the server setup.

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

## Important Design Decisions

- Do not reintroduce EJS pages. The project has moved to separated frontend/backend.
- Do not expand env config unless there is a strong reason. Most settings belong in SQLite setup/config pages.
- Server dashboard must not edit mappings. Mappings are controlled by the client.
- Client should not attempt to connect to the server before first-run setup is complete.
- Docker should remain easy to reset by default. Avoid adding DB volumes unless the user explicitly wants persistence.
- README should describe the client as a generic client host, not as a NAS-specific service.

## Current Caveats

- There is no full automated end-to-end tunnel test yet.
- Docker was not verified locally in this Windows workspace because Docker may not be installed or running.
- For public deployment behind Nginx or Cloudflare, upstream idle/read/send timeouts can still interrupt long uploads even though the app timeout is now idle-based.
- WebSocket fallback token in query string remains for compatibility but header auth is preferred.
