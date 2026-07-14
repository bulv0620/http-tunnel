import crypto from "node:crypto";

export const FRAME = {
  REQUEST_BODY: 1,
  RESPONSE_BODY: 2
};

export function createRequestId() {
  return crypto.randomBytes(16).toString("hex");
}

export function isRequestId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value);
}

export function encodeFrame(type, id, chunk) {
  if (![FRAME.REQUEST_BODY, FRAME.RESPONSE_BODY].includes(type)) throw new Error("invalid frame type");
  if (!isRequestId(id)) throw new Error("invalid request id");
  const header = Buffer.allocUnsafe(17);
  header.writeUInt8(type, 0);
  Buffer.from(id, "hex").copy(header, 1);
  return Buffer.concat([header, Buffer.from(chunk)]);
}

export function decodeFrame(frame) {
  const buffer = Buffer.from(frame);
  if (buffer.length < 17) return null;
  const type = buffer.readUInt8(0);
  if (![FRAME.REQUEST_BODY, FRAME.RESPONSE_BODY].includes(type)) return null;
  return {
    type,
    id: buffer.subarray(1, 17).toString("hex"),
    chunk: buffer.subarray(17)
  };
}

export async function writeStream(stream, chunk) {
  if (stream.destroyed || stream.writableEnded) return false;
  if (stream.write(chunk)) return true;
  return new Promise((resolve) => {
    const finish = (writable) => {
      stream.off("drain", onDrain);
      stream.off("close", onClose);
      stream.off("error", onError);
      resolve(writable);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    stream.once("drain", onDrain);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}
