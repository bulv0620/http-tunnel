import { reactive } from "vue";
import { api, setApiBase } from "./api/client.js";

export const state = reactive({
  ready: false,
  app: "",
  configured: false,
  authed: false,
  user: null,
  baseUrl: "/"
});

export async function refreshSetup() {
  const data = await api.setupStatus();
  state.ready = true;
  state.app = data.app;
  state.configured = Boolean(data.configured);
  state.authed = Boolean(data.user);
  state.user = data.user || null;
  state.baseUrl = data.baseUrl || "/";
  setApiBase(state.baseUrl);
  return data;
}

export function applyAuth(user) {
  state.authed = Boolean(user);
  state.user = user || null;
}

export function dashboardRoute() {
  return state.app === "client" ? "/client" : "/server";
}

export function configRoute() {
  return state.app === "client" ? "/client/config" : "/server/config";
}
