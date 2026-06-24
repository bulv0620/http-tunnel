import crypto from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_WS_BUFFER_LIMIT = 4 * 1024 * 1024;
const WS_OPEN = 1;

export const FRAME = {
  REQUEST_BODY: 1,
  RESPONSE_BODY: 2
};

export function createRequestId() {
  return crypto.randomBytes(16).toString("hex");
}

export function encodeFrame(type, id, chunk) {
  const header = Buffer.allocUnsafe(17);
  header.writeUInt8(type, 0);
  Buffer.from(id, "hex").copy(header, 1);
  return Buffer.concat([header, Buffer.from(chunk)]);
}

export function decodeFrame(frame) {
  const buffer = Buffer.from(frame);
  if (buffer.length < 17) return null;
  return {
    type: buffer.readUInt8(0),
    id: buffer.subarray(1, 17).toString("hex"),
    chunk: buffer.subarray(17)
  };
}

export async function waitForWsBackpressure(ws, limit = DEFAULT_WS_BUFFER_LIMIT) {
  while (ws.readyState === WS_OPEN && ws.bufferedAmount > limit) {
    await delay(5);
  }
  return ws.readyState === WS_OPEN;
}

export async function sendWs(ws, payload, options) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  const writable = await waitForWsBackpressure(ws);
  if (!writable) return false;
  return new Promise((resolve) => {
    ws.send(payload, options, (error) => resolve(!error));
  });
}

export async function writeStream(stream, chunk) {
  if (stream.destroyed || stream.writableEnded) return false;
  if (stream.write(chunk)) return true;
  try {
    await once(stream, "drain");
    return true;
  } catch {
    return false;
  }
}
