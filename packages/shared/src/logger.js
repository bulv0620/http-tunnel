export function createLogger(service, limit = 200) {
  const entries = [];
  function add(level, message, data = {}) {
    const entry = { time: new Date().toISOString(), level, service, message, data };
    entries.unshift(entry);
    if (entries.length > limit) entries.pop();
    console.log(JSON.stringify(entry));
  }
  return {
    entries,
    info: (message, data) => add("info", message, data),
    warn: (message, data) => add("warn", message, data),
    error: (message, data) => add("error", message, data)
  };
}
