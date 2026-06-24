<template>
  <main class="login-page wide">
    <el-card class="setup-card" shadow="never">
      <template #header>
        <div>
          <h1>{{ state.app === "client" ? "初始化客户端" : "初始化服务端" }}</h1>
          <div class="subtitle">首次运行需要保存基础配置，然后再登录管理端。</div>
        </div>
      </template>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="block-gap" />
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="基础路径">
            <el-input v-model="form.baseUrl" placeholder="/" />
          </el-form-item>
          <el-form-item label="管理员账号">
            <el-input v-model="form.adminUser" />
          </el-form-item>
          <el-form-item label="管理员密码">
            <el-input v-model="form.adminPassword" type="password" show-password />
          </el-form-item>
          <el-form-item label="Tunnel Token">
            <el-input v-model="form.tunnelToken" show-password />
          </el-form-item>

          <template v-if="state.app === 'client'">
            <el-form-item label="服务端 WebSocket 地址" class="span-2">
              <el-input v-model="form.serverUrl" />
            </el-form-item>
            <el-form-item label="客户端 ID">
              <el-input v-model="form.clientId" />
            </el-form-item>
            <el-form-item label="重连间隔 ms">
              <el-input-number v-model="form.reconnectMs" :min="500" class="full-input" />
            </el-form-item>
          </template>

          <el-form-item label="请求超时 ms">
            <el-input-number v-model="form.requestTimeoutMs" :min="1000" class="full-input" />
          </el-form-item>
          <el-form-item label="管理 API 请求体上限">
            <el-input-number v-model="sizeValue" :min="1024" class="full-input" />
          </el-form-item>
        </div>
        <el-button type="primary" class="full-button" @click="save">保存配置</el-button>
      </el-form>
    </el-card>
  </main>
</template>

<script setup>
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/client.js";
import { currentBaseUrl, setApiBase } from "../api/client.js";
import { refreshSetup, state } from "../store.js";

const router = useRouter();
const error = ref("");
const form = reactive({
  baseUrl: "/",
  adminUser: "admin",
  adminPassword: "",
  tunnelToken: "",
  serverUrl: "ws://127.0.0.1:12400/_tunnel/ws",
  clientId: "client",
  reconnectMs: 3000,
  requestTimeoutMs: 30000,
  maxBodyBytes: 65536,
  maxResponseBytes: 65536
});

const sizeValue = computed({
  get: () => (state.app === "client" ? form.maxResponseBytes : form.maxBodyBytes),
  set: (value) => {
    if (state.app === "client") form.maxResponseBytes = value;
    else form.maxBodyBytes = value;
  }
});

function jumpToBase(baseUrl) {
  const normalized = baseUrl && baseUrl !== "/" ? baseUrl : "";
  window.location.href = `${normalized}/#/login`;
}

async function save() {
  error.value = "";
  try {
    const payload = { ...form };
    const result = await api.setup(payload);
    const nextBase = result.redirectBaseUrl || form.baseUrl || currentBaseUrl();
    setApiBase(nextBase);
    await refreshSetup();
    jumpToBase(nextBase);
  } catch (err) {
    error.value = err.message || "配置保存失败";
  }
}
</script>
