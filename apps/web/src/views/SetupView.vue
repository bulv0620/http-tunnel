<template>
  <main class="login-page wide">
    <el-card class="setup-card" shadow="never">
      <template #header>
        <div>
          <h1>{{ state.app === "client" ? t("setup.clientTitle") : t("setup.serverTitle") }}</h1>
          <div class="subtitle">{{ t("setup.subtitle") }}</div>
        </div>
      </template>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="block-gap" />
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item :label="t('config.baseUrl')">
            <el-input v-model="form.baseUrl" placeholder="/" />
          </el-form-item>
          <el-form-item :label="t('config.adminUser')">
            <el-input v-model="form.adminUser" />
          </el-form-item>
          <el-form-item :label="t('config.adminPassword')">
            <el-input v-model="form.adminPassword" type="password" show-password />
          </el-form-item>
          <el-form-item :label="t('config.tunnelToken')">
            <el-input v-model="form.tunnelToken" show-password />
          </el-form-item>

          <template v-if="state.app === 'client'">
            <el-form-item :label="t('config.serverUrl')" class="span-2">
              <el-input v-model="form.serverUrl" />
            </el-form-item>
            <el-form-item :label="t('config.clientId')">
              <el-input v-model="form.clientId" />
            </el-form-item>
            <el-form-item :label="t('config.reconnectMs')">
              <el-input-number v-model="form.reconnectMs" :min="500" class="full-input" />
            </el-form-item>
          </template>

          <el-form-item :label="t('config.requestTimeoutMs')">
            <el-input-number v-model="form.requestTimeoutMs" :min="1000" class="full-input" />
          </el-form-item>
          <el-form-item :label="t('config.maxBodyBytes')">
            <el-input-number v-model="sizeValue" :min="1024" class="full-input" />
          </el-form-item>
        </div>
        <el-button type="primary" class="full-button" :loading="saving" @click="save">{{ t("config.save") }}</el-button>
      </el-form>
    </el-card>
  </main>
</template>

<script setup>
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/client.js";
import { currentBaseUrl, setApiBase } from "../api/client.js";
import { t } from "../i18n.js";
import { refreshSetup, state } from "../store.js";

const router = useRouter();
const error = ref("");
const saving = ref(false);
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
  if (saving.value) return;
  error.value = "";
  saving.value = true;
  try {
    const payload = { ...form };
    const result = await api.setup(payload);
    const nextBase = result.redirectBaseUrl || form.baseUrl || currentBaseUrl();
    setApiBase(nextBase);
    await refreshSetup();
    jumpToBase(nextBase);
  } catch (err) {
    error.value = err.message || t("config.saveFailed");
  } finally {
    saving.value = false;
  }
}
</script>
