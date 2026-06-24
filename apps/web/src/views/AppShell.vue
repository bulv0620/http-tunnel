<template>
  <main class="page">
    <div class="topbar">
      <div class="title">
        <h1>{{ title }}</h1>
        <div class="subtitle">{{ subtitle }}</div>
      </div>
      <div class="top-actions">
        <el-button text @click="router.push(dashboardRoute())">Dashboard</el-button>
        <el-button text @click="router.push(configRoute())">配置</el-button>
        <el-dropdown trigger="click">
          <div class="avatar">{{ adminInitial }}</div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
    <slot />
  </main>
</template>

<script setup>
import { computed } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/client.js";
import { applyAuth, configRoute, dashboardRoute, state } from "../store.js";

defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: "" }
});

const router = useRouter();
const adminInitial = computed(() => (state.user?.username || "A").slice(0, 1).toUpperCase());

async function logout() {
  await api.logout();
  applyAuth(null);
  router.push("/login");
}
</script>
