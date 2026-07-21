# http-tunnel

Node.js monorepo HTTP 内网穿透服务。

```text
apps/web      Vue 3 + Element Plus 管理前端
apps/server   公网服务端 API + Socket.IO 隧道入口 + 映射端口监听
apps/client   内网客户端 API + Socket.IO 隧道连接器
packages/shared  server/client 共享代码
```

前端构建后由 `apps/server` 和 `apps/client` 直接托管，不需要单独部署前端服务。

## 架构

```text
用户请求服务端映射端口（公网直连或经本机反向代理）
  -> apps/server
    -> Socket.IO（WebSocket transport）流式传输
      -> apps/client
        -> 内网 HTTP 服务
```

约束：

- 服务端只能对接一个客户端。
- 客户端只能连接一个服务端。
- 端口映射由客户端管理。
- 服务端只展示客户端上报的映射，不允许修改映射。
- 请求和响应 body 通过 Socket.IO 二进制事件流式传输。

## 配置与数据

监听地址和运行时安全/资源限制通过环境变量配置：

```env
# .env.server
HOST=0.0.0.0
PORT=12400

# .env.client
ADMIN_HOST=0.0.0.0
ADMIN_PORT=12500

# 可选：逗号分隔的跨域管理前端来源；默认只允许同源
CORS_ORIGINS=http://localhost:5173

# 仅在服务只通过可信反向代理访问时开启
TRUST_PROXY=false
SECURE_COOKIES=false

# 会话与资源保护默认值
SESSION_TTL_MS=43200000
MAX_SESSIONS=1000
MAX_CONCURRENT_REQUESTS=256
MAX_CONCURRENT_REQUESTS_PER_MAPPING=64
MAX_WS_PAYLOAD_BYTES=2097152
MAX_HEADER_BYTES=16384

# Socket.IO 最大重连退避
MAX_RECONNECT_DELAY_MS=15000
```

`TRUST_PROXY=true` 后才会信任 `X-Forwarded-For` 和 `X-Forwarded-Proto`。如果管理页面与 API 不同源，必须把完整 Origin 加入 `CORS_ORIGINS`；不要配置不受信任的来源。

隧道的连接心跳和自动重连由 Socket.IO/Engine.IO 管理。客户端启用无限重连、指数退避和随机抖动，基础延迟使用页面中的 `reconnectMs`，最大延迟默认 15 秒。项目不再发送自定义应用层心跳。控制消息使用普通 Socket.IO 事件，文件 body 使用独立二进制事件；发送端等待 Engine.IO 本地 `drain` 后继续读取 HTTP 流，不等待远端逐块 ACK。

业务配置和映射数据存到 SQLite：

```text
apps/server/db/server.sqlite
apps/client/db/client.sqlite
```

第一次运行时数据库会自动创建。服务端访问 `http://<ip>:12400`，客户端访问 `http://<ip>:12500`，页面会进入初始化配置。

## 映射访问方式

在客户端管理页新增或编辑映射时，可以选择服务端映射端口的访问方式：

- **公网 IP + 端口**：沿用原有行为，映射端口监听服务端配置的 `HOST`。未选择访问方式、旧版本创建的映射也默认使用此模式。
- **反向代理**：映射端口只监听 `127.0.0.1`，再由同一台主机上的 Nginx、Caddy 等反向代理转发到 `127.0.0.1:<映射端口>`，避免直接通过公网 IP 和端口访问。

例如映射端口为 `2234` 时，Nginx 可以将站点转发到：

```nginx
location / {
  proxy_pass http://127.0.0.1:2234;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

反向代理模式要求代理与服务端进程共享网络命名空间。它适用于 PM2/直接运行，或服务端使用 host 网络的 Docker 部署；bridge 容器中的 `127.0.0.1` 仅在容器内部可达。

## 本地运行

```bash
npm install
npm run build:web
npm run server
npm run client
```

首次访问：

```text
http://127.0.0.1:12400  # 服务端初始化/管理页
http://127.0.0.1:12500  # 客户端初始化/管理页
```

初始化完成后，如果基础路径配置为 `/admin`，访问地址会变成：

```text
http://127.0.0.1:12400/admin/
http://127.0.0.1:12500/admin/
```

服务端隧道入口固定为：

```text
ws://127.0.0.1:12400/_tunnel/ws
```

公网部署时建议使用：

```text
wss://你的域名/_tunnel/ws
```

## PM2 部署

如果不使用 Docker，可以用 PM2 在宿主机上守护运行服务端或客户端。

先安装依赖并构建前端：

```bash
npm install
npm run build:web
```

安装 PM2：

```bash
npm install -g pm2
```

启动服务端：

```bash
npm run pm2:server
```

启动客户端：

```bash
npm run pm2:client
```

如果同一台机器上需要同时运行服务端和客户端：

```bash
npm run pm2:start
```

常用命令：

```bash
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
npm run pm2:delete
```

让 PM2 在机器重启后自动恢复进程：

```bash
pm2 save
pm2 startup
```

## Docker 部署

项目已经提供：

```text
Dockerfile
deploy/docker/compose.server-host.yml
deploy/docker/compose.server-bridge.yml
deploy/docker/compose.client-host.yml
deploy/docker/compose.client-bridge.yml
```

Docker 镜像里不会打包 `.env.*` 文件。Docker 部署时，监听端口通过 compose 的 `environment` 设置；业务配置仍然在 Web 初始化页里保存到 SQLite。

### Docker 基础概念

你可以先记住这几个点：

- **镜像**：应用的安装包。
- **容器**：镜像运行起来后的进程。
- **端口映射**：把容器里的端口暴露到宿主机。
- **数据卷 volume**：可选功能，用来把数据库保存到容器外；本项目默认不启用，方便删除容器后重置配置。
- **host 网络**：容器直接使用宿主机网络，适合客户端需要访问宿主机或局域网服务的场景。
- **bridge 网络**：Docker 默认网络，容器和宿主机网络隔离。

### 部署服务端，推荐 host 网络

在服务器上进入项目目录：

```bash
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

也可以用项目脚本：

```bash
npm run docker:server
```

或者：

```bash
npm run docker:server:host
```

查看日志：

```bash
docker logs -f http-tunnel-server
```

首次访问：

```text
http://服务器IP:12400
```

初始化服务端时建议配置：

```text
基础路径：/admin
Tunnel Token：一串 32 位以上随机字符串
请求超时 ms：30000
管理 API 请求体上限：65536
```

如果你前面有 Nginx 或 Cloudflare，公网建议使用 HTTPS/WSS。

`请求超时 ms` 是隧道请求的空闲超时，不是总耗时。上传或下载过程中只要持续有数据流动，就会自动刷新计时；只有超过这个时间没有任何请求/响应数据流动，才会断开。

服务端推荐 host 网络，是因为服务端映射端口是动态创建的。host 网络下，客户端管理页里新增的服务器端口会直接监听在 VPS 宿主机上，不需要每新增一个端口就改 Docker 端口映射。

选择“反向代理”访问方式时，映射端口只绑定宿主机 `127.0.0.1`，可直接供宿主机上的 Nginx/Caddy 使用，也不会在公网网卡上监听。

### 服务端使用 bridge 网络

如果你更想要 Docker 网络隔离，也可以使用 bridge：

```bash
docker compose -f deploy/docker/compose.server-bridge.yml up -d --build
```

或者：

```bash
npm run docker:server:bridge
```

bridge 模式下，compose 只默认暴露 `12400`。如果你在客户端页面新增了服务器映射端口，比如 `2234`，需要同步修改 `deploy/docker/compose.server-bridge.yml`：

```yaml
ports:
  - "12400:12400"
  - "2234:2234"
```

然后重建服务端容器：

```bash
docker compose -f deploy/docker/compose.server-bridge.yml up -d --build
```

### 部署客户端，推荐 host 网络

如果客户端宿主机的 Docker 支持 host 网络，推荐用这个方式：

```bash
docker compose -f deploy/docker/compose.client-host.yml up -d --build
```

也可以用项目脚本：

```bash
npm run docker:client:host
```

首次访问：

```text
http://客户端宿主机IP:12500
```

host 网络下，容器访问客户端宿主机本机服务时可以用：

```text
127.0.0.1
```

例如客户端宿主机上的某个 HTTP 服务运行在 `5244`：

```text
服务器端口：2234
客户端主机：127.0.0.1
客户端端口：5244
```

### 客户端使用 bridge 网络

如果客户端宿主机不方便使用 host 网络，可以用 bridge：

```bash
docker compose -f deploy/docker/compose.client-bridge.yml up -d --build
```

也可以用项目脚本：

```bash
npm run docker:client:bridge
```

首次访问：

```text
http://客户端宿主机IP:12500
```

bridge 网络下，容器里的 `127.0.0.1` 指的是容器自己，不是客户端宿主机。要访问客户端宿主机服务，映射里通常写：

```text
客户端主机：host.docker.internal
客户端端口：你的服务端口
```

例如：

```text
服务器端口：2234
客户端主机：host.docker.internal
客户端端口：5244
```

`compose.client-bridge.yml` 已经加了：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### Docker 常用命令

启动：

```bash
docker compose -f deploy/docker/compose.server-host.yml up -d
```

停止：

```bash
docker compose -f deploy/docker/compose.server-host.yml down
```

重启：

```bash
docker restart http-tunnel-server
```

看日志：

```bash
docker logs -f http-tunnel-server
docker logs -f http-tunnel-client
```

重新构建并启动：

```bash
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

### 更新 Docker 部署

代码更新后，在服务器项目目录执行：

```bash
git pull
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

如果是客户端 host 模式：

```bash
git pull
docker compose -f deploy/docker/compose.client-host.yml up -d --build
```

如果是客户端 bridge 模式：

```bash
git pull
docker compose -f deploy/docker/compose.client-bridge.yml up -d --build
```

这些命令会重新构建镜像并替换容器。当前 compose 默认不挂载 Docker volume，SQLite 数据保存在容器内部，删除容器后会一起清空。

查看容器：

```bash
docker ps
```

进入容器：

```bash
docker exec -it http-tunnel-server sh
```

### Docker 数据与重置

当前 compose 默认不使用 Docker volume。SQLite 数据在容器内部：

```text
服务端：/app/apps/server/db/server.sqlite
客户端：/app/apps/client/db/client.sqlite
```

这样做的好处是重置很直接。删除容器后重新启动，就会回到首次初始化状态：

```bash
docker compose -f deploy/docker/compose.server-host.yml down
docker compose -f deploy/docker/compose.server-host.yml up -d --build
```

客户端同理：

```bash
docker compose -f deploy/docker/compose.client-host.yml down
docker compose -f deploy/docker/compose.client-host.yml up -d --build
```

注意：`docker restart` 只是重启同一个容器，不会清空 SQLite。只有删除容器再重新创建，才会重置容器内数据。

如果你以后想持久化数据库，可以在 compose 里自行加 volume。例如服务端：

```yaml
services:
  http-tunnel-server:
    volumes:
      - server-db:/app/apps/server/db

volumes:
  server-db:
```

客户端则把路径换成 `/app/apps/client/db`。

## 开发模式

后端：

```bash
npm run dev:server
npm run dev:client
```

单独启动前端：

```bash
npm run dev:web
```

`.env.web` 只用于前端开发服务：

```env
VITE_PORT=5173
VITE_API_BASE=http://127.0.0.1:12500
```

要调服务端管理页时，把 `VITE_API_BASE` 改成 `http://127.0.0.1:12400`。

## 管理页

前端包含：

- 登录页
- 首次初始化配置页
- 服务端配置页
- 客户端配置页
- 服务端 Dashboard
- 客户端 Dashboard

服务端和客户端都保留登录。客户端可以增删改查端口映射；服务端只读展示连接状态、映射状态、日志和审计日志。

## 安全建议

公网服务端建议：

- 管理端和 tunnel 入口放在 HTTPS/WSS 后面。
- Tunnel Token 使用 32 位以上随机字符串。
- 服务端管理路径不要使用 `/`，建议使用 `/admin` 或更随机的路径。
- 可以叠加 Cloudflare Access、Nginx Basic Auth 或 IP 白名单。
- 映射出来的业务服务自身也要有认证。

客户端如果只在可信局域网内访问，安全压力会小很多，但仍建议设置管理密码。

## API

公共：

- `GET /api/setup/status`
- `POST /api/setup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/status`
- `GET /api/config`
- `PUT /api/config`

客户端额外提供：

- `POST /api/mappings`
- `PUT /api/mappings/:id`
- `DELETE /api/mappings/:id`

服务端 Socket.IO（仅启用 WebSocket transport）：

- `/_tunnel/ws`
