export function normalizeMappings(value = []) {
  return value
    .map((item, index) => ({
      id: item.id || `map-${Date.now()}-${index}`,
      name: item.name || `mapping-${index + 1}`,
      serverPort: Number(item.serverPort),
      clientHost: item.clientHost || "127.0.0.1",
      clientPort: Number(item.clientPort),
      enabled: item.enabled !== false
    }))
    .filter((item) => item.serverPort > 0 && item.clientPort > 0);
}

export function mappingTarget(mapping) {
  return `http://${mapping.clientHost}:${mapping.clientPort}`;
}
