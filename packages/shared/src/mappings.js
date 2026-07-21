export const MAPPING_ACCESS_MODE = Object.freeze({
  DIRECT: "direct",
  REVERSE_PROXY: "reverse-proxy"
});

export function isMappingAccessMode(value) {
  return value === MAPPING_ACCESS_MODE.DIRECT || value === MAPPING_ACCESS_MODE.REVERSE_PROXY;
}

export function normalizeMappingAccessMode(value) {
  return value === MAPPING_ACCESS_MODE.REVERSE_PROXY
    ? MAPPING_ACCESS_MODE.REVERSE_PROXY
    : MAPPING_ACCESS_MODE.DIRECT;
}

export function mappingListenHost(mapping, defaultHost) {
  return normalizeMappingAccessMode(mapping?.accessMode) === MAPPING_ACCESS_MODE.REVERSE_PROXY
    ? "127.0.0.1"
    : defaultHost;
}

export function normalizeMappings(value = []) {
  return value
    .map((item, index) => ({
      id: item.id || `map-${Date.now()}-${index}`,
      name: item.name || `mapping-${index + 1}`,
      serverPort: Number(item.serverPort),
      clientHost: item.clientHost || "127.0.0.1",
      clientPort: Number(item.clientPort),
      accessMode: normalizeMappingAccessMode(item.accessMode),
      enabled: item.enabled !== false
    }))
    .filter((item) => item.serverPort > 0 && item.clientPort > 0);
}

export function mappingTarget(mapping) {
  return `http://${mapping.clientHost}:${mapping.clientPort}`;
}
