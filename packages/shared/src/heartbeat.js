export const TUNNEL_HEARTBEAT_INTERVAL_MS = 15000;
export const TUNNEL_HEARTBEAT_TIMEOUT_MS = 60000;
export const TUNNEL_HEARTBEAT_GRACE_MS = 0;
export const TUNNEL_HEARTBEAT_STALE_MS =
  TUNNEL_HEARTBEAT_INTERVAL_MS + TUNNEL_HEARTBEAT_TIMEOUT_MS + TUNNEL_HEARTBEAT_GRACE_MS;
export const TUNNEL_HEARTBEAT_CHECK_MS = 5000;
// If the local event loop was paused (for example by system sleep or a long GC),
// give the peer one short, fresh probe window instead of declaring a stale
// connection from an old wall-clock observation immediately.
export const TUNNEL_HEARTBEAT_LOOP_LAG_MS = 5000;
export const TUNNEL_HEARTBEAT_RECOVERY_MS = 10000;
export const TUNNEL_ACTIVE_PROBE_INTERVAL_MS = 5000;
export const TUNNEL_ACTIVE_PROBE_TIMEOUT_MS = 10000;
