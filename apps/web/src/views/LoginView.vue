<template>
  <main class="login-page">
    <el-card class="login-card" shadow="never">
      <template #header>
        <div class="login-brand">
          <img class="brand-icon" src="/icon.svg" alt="HTTP Tunnel" width="44" height="44" />
          <div>
            <h1>HTTP Tunnel</h1>
            <div class="subtitle">{{ t("auth.adminLogin") }}</div>
          </div>
        </div>
      </template>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="block-gap" />
      <el-form label-position="top" @submit.prevent="login">
        <el-form-item :label="t('auth.username')">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item :label="t('auth.password')">
          <el-input v-model="form.password" type="password" autocomplete="current-password" show-password />
        </el-form-item>
        <el-button type="primary" class="full-button" :loading="loading" @click="login">{{ t("auth.login") }}</el-button>
      </el-form>
    </el-card>
  </main>
</template>

<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/client.js";
import { t } from "../i18n.js";
import { applyAuth, dashboardRoute, state } from "../store.js";

const router = useRouter();
const error = ref("");
const loading = ref(false);
const form = reactive({ username: "admin", password: "" });

async function login() {
  if (loading.value) return;
  error.value = "";
  loading.value = true;
  try {
    await api.login(form);
    applyAuth({ username: form.username });
    router.push(dashboardRoute());
  } catch (err) {
    error.value = err.status === 401 ? t("auth.invalidCredentials") : err.message || t("auth.loginFailed");
    if (!state.configured) router.push("/setup");
  } finally {
    loading.value = false;
  }
}
</script>
