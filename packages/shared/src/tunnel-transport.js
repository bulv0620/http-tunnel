export const TUNNEL_EVENT = "tunnel";
export const TUNNEL_SEND_TIMEOUT_MS = 30000;

export function isTunnelConnected(socket) {
  return Boolean(socket?.connected);
}

export function sendTunnel(socket, payload, timeoutMs = TUNNEL_SEND_TIMEOUT_MS) {
  if (!isTunnelConnected(socket)) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      socket.timeout(timeoutMs).emit(TUNNEL_EVENT, payload, (error) => {
        resolve(!error && isTunnelConnected(socket));
      });
    } catch {
      resolve(false);
    }
  });
}
