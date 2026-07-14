import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import { clientIp } from "../src/audit.js";
import { clearSessions, createLoginRateLimiter, currentUser, login } from "../src/auth.js";
import { applyCors } from "../src/cors.js";
import { toHeaderObject } from "../src/http-utils.js";
import { hashPassword } from "../src/password.js";
import {
  FRAME,
  decodeFrame,
  encodeFrame,
  isRequestId,
  writeStream
} from "../src/stream-protocol.js";
import { TUNNEL_EVENT, sendTunnel } from "../src/tunnel-transport.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: Buffer.alloc(0),
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(body = "") {
      this.body = Buffer.from(body);
    }
  };
}

test("CORS allows same-origin and rejects unlisted cross-origin requests", () => {
  const sameOriginResponse = mockResponse();
  assert.equal(applyCors({ method: "GET", headers: { host: "admin.example.com", origin: "https://admin.example.com" } }, sameOriginResponse), false);
  assert.equal(sameOriginResponse.headers["access-control-allow-origin"], "https://admin.example.com");

  const rejectedResponse = mockResponse();
  assert.equal(applyCors({ method: "POST", headers: { host: "admin.example.com", origin: "https://evil.example" } }, rejectedResponse), true);
  assert.equal(rejectedResponse.statusCode, 403);

  const allowedResponse = mockResponse();
  assert.equal(applyCors(
    { method: "OPTIONS", headers: { host: "127.0.0.1:12400", origin: "http://localhost:5173" } },
    allowedResponse,
    { allowedOrigins: ["http://localhost:5173"] }
  ), true);
  assert.equal(allowedResponse.statusCode, 204);
});

test("proxy headers are ignored unless proxy trust is explicitly enabled", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.5" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req), "127.0.0.1");
  assert.equal(clientIp(req, true), "203.0.113.5");

  const limiter = createLoginRateLimiter({ maxFailures: 2 });
  limiter.failure(req);
  limiter.failure({ ...req, headers: { "x-forwarded-for": "203.0.113.6" } });
  assert.equal(limiter.check(req).allowed, false);
});

test("login sessions are bounded by secure cookie settings", async () => {
  const req = Readable.from([Buffer.from(JSON.stringify({ username: "admin", password: "test-password" }))]);
  req.headers = { "x-forwarded-proto": "https" };
  req.socket = { remoteAddress: "127.0.0.1", encrypted: true };
  const res = mockResponse();
  await login(req, res, {
    adminUser: "admin",
    adminPassword: hashPassword("test-password"),
    maxSessions: 1,
    sessionTtlMs: 60000
  });
  const cookie = res.headers["set-cookie"];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const sid = cookie.split(";")[0];
  assert.equal(currentUser({ headers: { cookie: sid } }, { adminUser: "admin", sessionTtlMs: 60000 }), "admin");
  clearSessions();
});

test("header forwarding removes connection-nominated headers and preserves cookie arrays", () => {
  assert.deepEqual(toHeaderObject({
    connection: "keep-alive, x-internal",
    "x-internal": "remove-me",
    "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    "content-type": "text/plain"
  }), {
    "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    "content-type": "text/plain"
  });
});

test("stream frames validate request ids and frame types", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(isRequestId(id), true);
  const encoded = encodeFrame(FRAME.REQUEST_BODY, id, Buffer.from("body"));
  assert.deepEqual(decodeFrame(encoded), { type: FRAME.REQUEST_BODY, id, chunk: Buffer.from("body") });
  assert.throws(() => encodeFrame(99, id, Buffer.alloc(0)), /invalid frame type/);
  assert.throws(() => encodeFrame(FRAME.REQUEST_BODY, "bad", Buffer.alloc(0)), /invalid request id/);
  assert.equal(decodeFrame(Buffer.concat([Buffer.from([99]), Buffer.alloc(16)])), null);
});

test("Socket.IO tunnel sends require acknowledgements", async () => {
  const socket = {
    connected: true,
    timeout() {
      return this;
    },
    emit(event, payload, acknowledge) {
      assert.equal(event, TUNNEL_EVENT);
      assert.deepEqual(payload, { type: "hello" });
      acknowledge();
    }
  };
  assert.equal(await sendTunnel(socket, { type: "hello" }), true);
  socket.connected = false;
  assert.equal(await sendTunnel(socket, { type: "hello" }), false);
});

test("stream close resolves as a failed write", async () => {
  class ClosingStream extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    write() {
      return false;
    }
  }
  const stream = new ClosingStream();
  const write = writeStream(stream, Buffer.from("data"));
  stream.emit("close");
  assert.equal(await write, false);
});
