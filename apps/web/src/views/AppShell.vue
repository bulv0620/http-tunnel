<template>
  <main class="page">
    <div class="topbar">
      <div class="title">
        <div class="eyebrow">{{ t("app.controlCenter") }}</div>
        <h1>{{ title }}</h1>
        <div class="subtitle">{{ subtitle }}</div>
      </div>
      <div class="top-actions">
        <el-button class="locale-button" :aria-label="t('app.language')" :icon="Connection" text @click="toggleLocale">{{ currentLanguageLabel }}</el-button>
        <div class="nav-actions">
          <el-button :class="{ active: isDashboard }" :icon="DataLine" text @click="router.push(dashboardRoute())">{{ t("app.dashboard") }}</el-button>
          <el-button :class="{ active: isConfig }" :icon="Setting" text @click="router.push(configRoute())">{{ t("app.config") }}</el-button>
        </div>
        <el-dropdown trigger="click">
          <div class="avatar">{{ adminInitial }}</div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item :icon="SwitchButton" :disabled="loggingOut" @click="logout">{{ t("app.logout") }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
    <div class="content-surface">
      <slot />
    </div>
  </main>
</template>

<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Connection, DataLine, Setting, SwitchButton } from "@element-plus/icons-vue";
import { api } from "../api/client.js";
import { currentLanguageLabel, t, toggleLocale } from "../i18n.js";
import { applyAuth, configRoute, dashboardRoute, state } from "../store.js";

defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: "" }
});

const router = useRouter();
const adminInitial = computed(() => (state.user?.username || "A").slice(0, 1).toUpperCase());
const isDashboard = computed(() => router.currentRoute.value.path === dashboardRoute());
const isConfig = computed(() => router.currentRoute.value.path === configRoute());
const loggingOut = ref(false);

async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await api.logout();
    applyAuth(null);
    router.push("/login");
  } catch (err) {
    ElMessage.error(err.message || t("auth.loginFailed"));
  } finally {
    loggingOut.value = false;
  }
}
</script>
