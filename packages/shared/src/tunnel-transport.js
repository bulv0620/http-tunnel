export const TUNNEL_CONTROL_EVENT = "tunnel-control";
export const TUNNEL_DATA_EVENT = "tunnel-data";

export function isTunnelConnected(socket) {
  return Boolean(socket?.connected);
}

export function sendTunnelControl(socket, payload) {
  if (!isTunnelConnected(socket)) return false;
  try {
    socket.emit(TUNNEL_CONTROL_EVENT, payload);
    return true;
  } catch {
    return false;
  }
}

function engineFor(socket) {
  return socket?.conn || socket?.io?.engine || null;
}

export function sendTunnelData(socket, payload) {
  if (!isTunnelConnected(socket)) return Promise.resolve(false);
  const engine = engineFor(socket);
  if (!engine) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sent) => {
      if (settled) return;
      settled = true;
      engine.off("drain", onDrain);
      socket.off("disconnect", onDisconnect);
      resolve(sent);
    };
    const onDrain = () => finish(isTunnelConnected(socket));
    const onDisconnect = () => finish(false);
    engine.once("drain", onDrain);
    socket.once("disconnect", onDisconnect);
    try {
      socket.emit(TUNNEL_DATA_EVENT, payload);
    } catch {
      finish(false);
    }
  });
}
