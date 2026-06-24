import { createRouter, createWebHashHistory } from "vue-router";
import { dashboardRoute, refreshSetup, state } from "./store.js";
import LoginView from "./views/LoginView.vue";
import SetupView from "./views/SetupView.vue";
import ServerDashboard from "./views/ServerDashboard.vue";
import ClientDashboard from "./views/ClientDashboard.vue";
import ServerConfig from "./views/ServerConfig.vue";
import ClientConfig from "./views/ClientConfig.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: () => dashboardRoute() },
    { path: "/setup", name: "setup", component: SetupView },
    { path: "/login", name: "login", component: LoginView },
    { path: "/server", name: "server-dashboard", component: ServerDashboard, meta: { requiresAuth: true, app: "server" } },
    { path: "/client", name: "client-dashboard", component: ClientDashboard, meta: { requiresAuth: true, app: "client" } },
    { path: "/server/config", name: "server-config", component: ServerConfig, meta: { requiresAuth: true, app: "server" } },
    { path: "/client/config", name: "client-config", component: ClientConfig, meta: { requiresAuth: true, app: "client" } },
    { path: "/:pathMatch(.*)*", redirect: () => dashboardRoute() }
  ]
});

router.beforeEach(async (to) => {
  if (!state.ready) await refreshSetup();

  if (!state.configured && to.name !== "setup") return "/setup";
  if (state.configured && to.name === "setup") return state.authed ? dashboardRoute() : "/login";
  if (to.meta.requiresAuth && !state.authed) return "/login";
  if (to.name === "login" && state.authed) return dashboardRoute();
  if (to.meta.app && to.meta.app !== state.app) return dashboardRoute();
  return true;
});
