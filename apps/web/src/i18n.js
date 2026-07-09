import { computed, reactive } from "vue";

const STORAGE_KEY = "http-tunnel.locale";

export const messages = {
  "zh-CN": {
    app: {
      controlCenter: "Control Center",
      dashboard: "Dashboard",
      config: "配置",
      logout: "退出登录",
      language: "语言",
      languageShort: "中"
    },
    auth: {
      adminLogin: "管理员登录",
      username: "账号",
      password: "密码",
      login: "登录",
      invalidCredentials: "账号或密码不正确",
      loginFailed: "登录失败"
    },
    setup: {
      clientTitle: "初始化客户端",
      serverTitle: "初始化服务端",
      subtitle: "首次运行需要保存基础配置，然后再登录管理端。"
    },
    config: {
      serverTitle: "服务端配置",
      clientTitle: "客户端配置",
      subtitle: "配置保存到本地 SQLite，基础路径变更后会自动跳转。",
      basic: "基础配置",
      baseUrl: "基础路径",
      adminUser: "管理员账号",
      adminPassword: "管理员密码",
      tunnelToken: "Tunnel Token",
      serverUrl: "服务端 WebSocket 地址",
      clientId: "客户端 ID",
      reconnectMs: "重连间隔 ms",
      requestTimeoutMs: "请求超时 ms",
      maxBodyBytes: "管理 API 请求体上限",
      save: "保存配置",
      saved: "配置已保存",
      saveFailed: "配置保存失败",
      restartConnection: "重启连接",
      restartStarted: "连接重启已触发",
      restartFailed: "连接重启失败"
    },
    dashboard: {
      serverTitle: "HTTP Tunnel Server",
      clientTitle: "HTTP Tunnel Client",
      serverSubtitle: "服务端 Dashboard",
      clientSubtitle: "客户端 Dashboard",
      clientConnection: "客户端连接",
      serverConnection: "服务端连接",
      connected: "已连接",
      disconnected: "未连接",
      disabled: "已停用",
      enabled: "已启用",
      client: "客户端",
      clientId: "客户端 ID",
      mappingCount: "映射数量",
      pendingRequests: "待处理请求",
      lastError: "最近错误",
      noError: "无错误",
      clientConnectionDetail: "客户端连接情况",
      serverConnectionDetail: "服务端连接情况",
      clientOnline: "客户端在线",
      waitingClient: "等待客户端连接",
      noClientConnected: "当前没有客户端连接到服务端",
      serverOnline: "服务端在线",
      waitingServer: "正在等待连接",
      noServerUrl: "尚未配置服务端 WebSocket 地址",
      connectedAt: "连接时间",
      latency: "心跳延迟",
      lastHeartbeat: "最后心跳",
      serverWsUrl: "服务端 WebSocket 地址",
      token: "Token",
      tokenSet: "已设置",
      tokenUnset: "未设置",
      reconnectMs: "重连间隔",
      requestTimeoutMs: "请求超时",
      maxBodyBytes: "管理 API 请求体上限",
      mappings: "端口映射情况",
      autoRefresh: "自动刷新",
      refresh: "刷新",
      addMapping: "新增映射",
      connectionStatus: "连接状态",
      mapping: "映射",
      requestCount: "请求数",
      activeRequests: "并发",
      errors: "错误",
      traffic: "流量",
      realtimeRate: "实时速率",
      lastAccess: "最近访问",
      actions: "操作",
      inbound: "入",
      outbound: "出",
      edit: "编辑",
      delete: "删除",
      logs: "日志",
      noLogs: "暂无日志",
      auditLogs: "审计日志",
      noAuditLogs: "暂无审计日志",
      editMapping: "编辑端口映射",
      createMapping: "新增端口映射",
      name: "名称",
      serverPort: "服务器端口",
      clientHost: "客户端主机",
      clientPort: "客户端端口",
      enable: "启用",
      cancel: "取消",
      save: "保存",
      webDefaultName: "Web",
      mappingSaved: "映射已保存",
      deleteConfirm: "删除映射 {name}？",
      confirmDelete: "确认删除",
      mappingDeleted: "映射已删除"
    }
  },
  en: {
    app: {
      controlCenter: "Control Center",
      dashboard: "Dashboard",
      config: "Config",
      logout: "Log out",
      language: "Language",
      languageShort: "EN"
    },
    auth: {
      adminLogin: "Admin sign in",
      username: "Username",
      password: "Password",
      login: "Sign in",
      invalidCredentials: "Incorrect username or password",
      loginFailed: "Sign in failed"
    },
    setup: {
      clientTitle: "Initialize Client",
      serverTitle: "Initialize Server",
      subtitle: "Save the basic configuration before signing in to the admin console."
    },
    config: {
      serverTitle: "Server Config",
      clientTitle: "Client Config",
      subtitle: "Configuration is saved to local SQLite. Changing the base path redirects automatically.",
      basic: "Basic Config",
      baseUrl: "Base Path",
      adminUser: "Admin Username",
      adminPassword: "Admin Password",
      tunnelToken: "Tunnel Token",
      serverUrl: "Server WebSocket URL",
      clientId: "Client ID",
      reconnectMs: "Reconnect Interval ms",
      requestTimeoutMs: "Request Timeout ms",
      maxBodyBytes: "Admin API Body Limit",
      save: "Save Config",
      saved: "Config saved",
      saveFailed: "Failed to save config",
      restartConnection: "Restart Connection",
      restartStarted: "Connection restart requested",
      restartFailed: "Failed to restart connection"
    },
    dashboard: {
      serverTitle: "HTTP Tunnel Server",
      clientTitle: "HTTP Tunnel Client",
      serverSubtitle: "Server Dashboard",
      clientSubtitle: "Client Dashboard",
      clientConnection: "Client Connection",
      serverConnection: "Server Connection",
      connected: "Connected",
      disconnected: "Disconnected",
      disabled: "Disabled",
      enabled: "Enabled",
      client: "Client",
      clientId: "Client ID",
      mappingCount: "Mappings",
      pendingRequests: "Pending Requests",
      lastError: "Last Error",
      noError: "None",
      clientConnectionDetail: "Client Connection",
      serverConnectionDetail: "Server Connection",
      clientOnline: "Client Online",
      waitingClient: "Waiting for client",
      noClientConnected: "No client is connected to the server",
      serverOnline: "Server Online",
      waitingServer: "Waiting for connection",
      noServerUrl: "Server WebSocket URL is not configured",
      connectedAt: "Connected At",
      latency: "Heartbeat Latency",
      lastHeartbeat: "Last Heartbeat",
      serverWsUrl: "Server WebSocket URL",
      token: "Token",
      tokenSet: "Set",
      tokenUnset: "Not set",
      reconnectMs: "Reconnect Interval",
      requestTimeoutMs: "Request Timeout",
      maxBodyBytes: "Admin API Body Limit",
      mappings: "Port Mappings",
      autoRefresh: "Auto refresh",
      refresh: "Refresh",
      addMapping: "New Mapping",
      connectionStatus: "Status",
      mapping: "Mapping",
      requestCount: "Requests",
      activeRequests: "Active",
      errors: "Errors",
      traffic: "Traffic",
      realtimeRate: "Realtime Rate",
      lastAccess: "Last Access",
      actions: "Actions",
      inbound: "I",
      outbound: "O",
      edit: "Edit",
      delete: "Delete",
      logs: "Logs",
      noLogs: "No logs",
      auditLogs: "Audit Logs",
      noAuditLogs: "No audit logs",
      editMapping: "Edit Mapping",
      createMapping: "New Mapping",
      name: "Name",
      serverPort: "Server Port",
      clientHost: "Client Host",
      clientPort: "Client Port",
      enable: "Enable",
      cancel: "Cancel",
      save: "Save",
      webDefaultName: "Web",
      mappingSaved: "Mapping saved",
      deleteConfirm: "Delete mapping {name}?",
      confirmDelete: "Confirm Delete",
      mappingDeleted: "Mapping deleted"
    }
  }
};

export const i18nState = reactive({
  locale: localStorage.getItem(STORAGE_KEY) || "en"
});

export const currentLanguageLabel = computed(() => t("app.languageShort"));

export function setLocale(locale) {
  i18nState.locale = messages[locale] ? locale : "en";
  localStorage.setItem(STORAGE_KEY, i18nState.locale);
}

export function toggleLocale() {
  setLocale(i18nState.locale === "zh-CN" ? "en" : "zh-CN");
}

export function t(key, params = {}) {
  const value = key.split(".").reduce((node, part) => node?.[part], messages[i18nState.locale]) ?? key;
  return Object.entries(params).reduce((text, [name, replacement]) => {
    return text.replaceAll(`{${name}}`, String(replacement));
  }, value);
}
