<template>
  <main class="login-page">
    <el-card class="login-card" shadow="never">
      <template #header>
        <div>
          <h1>HTTP Tunnel</h1>
          <div class="subtitle">管理员登录</div>
        </div>
      </template>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="block-gap" />
      <el-form label-position="top" @submit.prevent="login">
        <el-form-item label="账号">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" autocomplete="current-password" show-password />
        </el-form-item>
        <el-button type="primary" class="full-button" @click="login">登录</el-button>
      </el-form>
    </el-card>
  </main>
</template>

<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/client.js";
import { applyAuth, dashboardRoute, state } from "../store.js";

const router = useRouter();
const error = ref("");
const form = reactive({ username: "admin", password: "" });

async function login() {
  error.value = "";
  try {
    await api.login(form);
    applyAuth({ username: form.username });
    router.push(dashboardRoute());
  } catch (err) {
    error.value = err.status === 401 ? "账号或密码不正确" : err.message || "登录失败";
    if (!state.configured) router.push("/setup");
  }
}
</script>
