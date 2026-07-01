import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import { onUnauthorized } from "./api/client.js";
import { router } from "./router.js";
import { applyAuth } from "./store.js";
import "./style.css";

onUnauthorized(() => {
  applyAuth(null);
  if (router.currentRoute.value.name !== "login") router.push("/login");
});

createApp(App).use(ElementPlus).use(router).mount("#app");
