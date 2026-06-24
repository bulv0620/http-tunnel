<template>
  <AppShell :title="title" subtitle="配置保存到本地 SQLite，基础路径变更后会自动跳转。">
    <section class="panel">
      <div class="panel-head"><h2>基础配置</h2></div>
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

          <template v-if="mode === 'client'">
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
        <el-button type="primary" @click="save">保存配置</el-button>
      </el-form>
    </section>
  </AppShell>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import AppShell from "./AppShell.vue";
import { api, setApiBase } from "../api/client.js";
import { refreshSetup } from "../store.js";

const props = defineProps({
  mode: { type: String, required: true }
});

const error = ref("");
const form = reactive({
  baseUrl: "/",
  adminUser: "admin",
  adminPassword: "",
  tunnelToken: "",
  serverUrl: "",
  clientId: "",
  reconnectMs: 3000,
  requestTimeoutMs: 30000,
  maxBodyBytes: 65536,
  maxResponseBytes: 65536
});

const title = computed(() => (props.mode === "server" ? "服务端配置" : "客户端配置"));
const sizeValue = computed({
  get: () => (props.mode === "client" ? form.maxResponseBytes : form.maxBodyBytes),
  set: (value) => {
    if (props.mode === "client") form.maxResponseBytes = value;
    else form.maxBodyBytes = value;
  }
});

function applyConfig(config) {
  Object.assign(form, config);
}

function jumpToBase(baseUrl) {
  if (!baseUrl) return;
  const normalized = baseUrl === "/" ? "" : baseUrl;
  window.location.href = `${normalized}/#/${props.mode}/config`;
}

async function loadConfig() {
  const data = await api.config();
  applyConfig(data.config);
}

async function save() {
  error.value = "";
  try {
    const data = await api.saveConfig(form);
    applyConfig(data.config);
    setApiBase(data.config.baseUrl);
    await refreshSetup();
    ElMessage.success("配置已保存");
    if (data.redirectBaseUrl) jumpToBase(data.redirectBaseUrl);
  } catch (err) {
    error.value = err.message || "配置保存失败";
  }
}

onMounted(loadConfig);
</script>
