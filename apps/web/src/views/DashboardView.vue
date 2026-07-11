<template>
  <AppShell :title="title" :subtitle="subtitle">
    <el-alert v-if="statusError" :title="statusError" type="error" show-icon :closable="false" class="block-gap" />

    <section class="metric-grid" v-loading="statusLoading && !Object.keys(status).length">
      <div class="metric-card">
        <div class="metric-label">{{ mode === "server" ? t("dashboard.clientConnection") : t("dashboard.serverConnection") }}</div>
        <div class="metric-value">
          <span class="connection-badge" :class="{ online: mainConnected }">
            <span></span>{{ mainConnected ? t("dashboard.connected") : t("dashboard.disconnected") }}
          </span>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">{{ mode === "server" ? t("dashboard.client") : t("dashboard.clientId") }}</div>
        <div class="metric-value">{{ identityText }}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">{{ t("dashboard.mappingCount") }}</div>
        <div class="metric-value">{{ mappings.length }}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">{{ mode === "server" ? t("dashboard.pendingRequests") : t("dashboard.lastError") }}</div>
        <div v-if="mode === 'server'" class="metric-value">{{ status.pending || 0 }}</div>
        <div v-else class="metric-error" :class="{ empty: !status.lastError }">
          {{ status.lastError || t("dashboard.noError") }}
        </div>
      </div>
    </section>

    <section v-if="mode === 'server'" class="panel connection-panel">
      <div class="panel-head"><h2>{{ t("dashboard.clientConnectionDetail") }}</h2></div>
      <div class="connection-summary">
        <div class="connection-mark" :class="{ online: mainConnected }"></div>
        <div>
          <div class="connection-title">{{ mainConnected ? t("dashboard.clientOnline") : t("dashboard.waitingClient") }}</div>
          <div class="connection-subtitle">{{ status.client?.id || t("dashboard.noClientConnected") }}</div>
        </div>
      </div>
      <div class="connection-grid">
        <div class="connection-item">
          <span>{{ t("dashboard.clientId") }}</span>
          <strong>{{ status.client?.id || "-" }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.connectedAt") }}</span>
          <strong>{{ formatTime(status.client?.connectedAt) }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.latency") }}</span>
          <strong>{{ status.client?.latencyMs ?? "-" }} ms</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.lastHeartbeat") }}</span>
          <strong>{{ formatTime(status.client?.lastPongAt) }}</strong>
        </div>
      </div>
    </section>

    <section v-if="mode === 'client'" class="panel connection-panel">
      <div class="panel-head"><h2>{{ t("dashboard.serverConnectionDetail") }}</h2></div>
      <div class="connection-summary">
        <div class="connection-mark" :class="{ online: mainConnected }"></div>
        <div>
          <div class="connection-title">{{ mainConnected ? t("dashboard.serverOnline") : t("dashboard.waitingServer") }}</div>
          <div class="connection-subtitle">{{ status.config?.serverUrl || t("dashboard.noServerUrl") }}</div>
        </div>
      </div>
      <div class="connection-grid">
        <div class="connection-item span-wide">
          <span>{{ t("dashboard.serverWsUrl") }}</span>
          <strong>{{ status.config?.serverUrl || "-" }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.clientId") }}</span>
          <strong>{{ status.config?.clientId || "-" }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.token") }}</span>
          <strong>{{ status.config?.tunnelToken ? t("dashboard.tokenSet") : t("dashboard.tokenUnset") }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.endToEndHeartbeat") }}</span>
          <strong>{{ formatTime(status.lastServerProbeAckAt || status.lastServerPingAt) }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.endToEndLatency") }}</span>
          <strong>{{ status.serverProbeLatencyMs ?? "-" }} ms</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.reconnectMs") }}</span>
          <strong>{{ status.config?.reconnectMs }} ms</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.reconnectAttempt") }}</span>
          <strong>{{ status.reconnectAttempt || 0 }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.nextReconnectAt") }}</span>
          <strong>{{ formatTime(status.nextReconnectAt) }}</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.requestTimeoutMs") }}</span>
          <strong>{{ status.config?.requestTimeoutMs }} ms</strong>
        </div>
        <div class="connection-item">
          <span>{{ t("dashboard.maxBodyBytes") }}</span>
          <strong>{{ status.config?.maxResponseBytes }}</strong>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>{{ t("dashboard.mappings") }}</h2>
        <div class="panel-actions">
          <el-switch v-model="autoRefresh" :active-text="t('dashboard.autoRefresh')" />
          <el-button :icon="Refresh" :loading="statusLoading" @click="loadStatus()">{{ t("dashboard.refresh") }}</el-button>
          <el-button v-if="mode === 'client'" :icon="Plus" type="primary" @click="openCreate">{{ t("dashboard.addMapping") }}</el-button>
        </div>
      </div>
      <el-table :data="mappings" class="mapping-table" stripe style="width: 100%">
        <el-table-column :label="t('dashboard.connectionStatus')" width="128">
          <template #default="{ row }">
            <span class="status-pill" :class="statusClass(row.status)" :title="row.statusMessage || statusText(row.status)">
              <span></span>{{ statusText(row.status) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column :label="t('dashboard.mapping')" min-width="240">
          <template #default="{ row }">
            <div class="mapping-name">{{ row.name || "-" }}</div>
            <div class="mapping-route">
              :{{ row.serverPort }} <span>-></span> {{ row.clientHost }}:{{ row.clientPort }}
            </div>
            <div v-if="row.statusMessage" class="mapping-error">{{ row.statusMessage }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('dashboard.requestCount')" width="90">
          <template #default="{ row }"><span class="table-number">{{ row.stats?.requestCount || 0 }}</span></template>
        </el-table-column>
        <el-table-column :label="t('dashboard.activeRequests')" width="80">
          <template #default="{ row }"><span class="table-number">{{ row.stats?.activeRequests || 0 }}</span></template>
        </el-table-column>
        <el-table-column :label="t('dashboard.errors')" width="80">
          <template #default="{ row }">
            <span class="table-number error-number" :class="{ 'has-error': row.stats?.errorCount > 0 }">{{ row.stats?.errorCount || 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('dashboard.traffic')" min-width="170">
          <template #default="{ row }">
            <div class="dual-metric">
              <span><b>{{ t("dashboard.inbound") }}</b>{{ formatBytes(row.stats?.bytesIn || 0) }}</span>
              <span><b>{{ t("dashboard.outbound") }}</b>{{ formatBytes(row.stats?.bytesOut || 0) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('dashboard.realtimeRate')" min-width="170">
          <template #default="{ row }">
            <div class="dual-metric">
              <span><b>{{ t("dashboard.inbound") }}</b>{{ formatBytes(row.stats?.rateInBps || 0) }}/s</span>
              <span><b>{{ t("dashboard.outbound") }}</b>{{ formatBytes(row.stats?.rateOutBps || 0) }}/s</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('dashboard.lastAccess')" min-width="170">
          <template #default="{ row }"><span class="table-time">{{ formatTime(row.stats?.lastAccessAt) }}</span></template>
        </el-table-column>
        <el-table-column v-if="mode === 'client'" :label="t('dashboard.actions')" width="190" fixed="right">
          <template #default="{ row }">
            <div class="operation-cell">
              <label class="enable-control">
                <span>{{ row.enabled ? t("dashboard.enabled") : t("dashboard.disabled") }}</span>
                <el-switch v-model="row.enabled" size="small" :loading="isMappingSaving(row.id)" :disabled="isMappingSaving(row.id)" @change="(enabled) => saveMapping(row, enabled)" />
              </label>
              <div class="table-actions">
                <button type="button" class="row-action" :disabled="isMappingSaving(row.id)" @click="openEdit(row)">{{ t("dashboard.edit") }}</button>
                <button type="button" class="row-action danger" :disabled="isMappingSaving(row.id)" @click="deleteMapping(row)">{{ t("dashboard.delete") }}</button>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>{{ t("dashboard.logs") }}</h2></div>
      <div class="log-list">
        <el-scrollbar max-height="340px">
          <div class="log-list-inner">
            <el-empty v-if="!logs.length" :description="t('dashboard.noLogs')" />
            <div v-for="item in logs" :key="item.time + item.message" class="log-line">
              <code class="log-time">{{ formatTime(item.time) }}</code>
              <span class="log-level" :class="item.level">
                {{ item.level }}
              </span>
              <span>{{ item.message }} <code>{{ JSON.stringify(item.data) }}</code></span>
            </div>
          </div>
        </el-scrollbar>
      </div>
    </section>

    <section v-if="mode === 'server'" class="panel">
      <div class="panel-head"><h2>{{ t("dashboard.auditLogs") }}</h2></div>
      <div class="log-list">
        <el-scrollbar max-height="340px">
          <div class="log-list-inner">
            <el-empty v-if="!auditLogs.length" :description="t('dashboard.noAuditLogs')" />
            <div v-for="item in auditLogs" :key="item.id" class="log-line audit-line">
              <code class="log-time">{{ formatTime(item.time) }}</code>
              <span class="log-level audit">{{ item.event }}</span>
              <span>{{ item.actor || "-" }} {{ item.ip || "" }} <code>{{ JSON.stringify(item.data) }}</code></span>
            </div>
          </div>
        </el-scrollbar>
      </div>
    </section>

    <el-dialog v-model="mappingVisible" :title="editingId ? t('dashboard.editMapping') : t('dashboard.createMapping')" width="560px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item :label="t('dashboard.name')"><el-input v-model="mappingForm.name" /></el-form-item>
          <el-form-item :label="t('dashboard.serverPort')"><el-input-number v-model="mappingForm.serverPort" :min="1" class="full-input" /></el-form-item>
          <el-form-item :label="t('dashboard.clientHost')"><el-input v-model="mappingForm.clientHost" /></el-form-item>
          <el-form-item :label="t('dashboard.clientPort')"><el-input-number v-model="mappingForm.clientPort" :min="1" class="full-input" /></el-form-item>
          <el-form-item :label="t('dashboard.enable')"><el-switch v-model="mappingForm.enabled" /></el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="mappingVisible = false">{{ t("dashboard.cancel") }}</el-button>
        <el-button type="primary" :loading="mappingDialogSaving" @click="saveMappingDialog">{{ t("dashboard.save") }}</el-button>
      </template>
    </el-dialog>
  </AppShell>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Plus, Refresh } from "@element-plus/icons-vue";
import AppShell from "./AppShell.vue";
import { api } from "../api/client.js";
import { t } from "../i18n.js";

const props = defineProps({
  mode: { type: String, required: true }
});

const status = ref({});
const mappings = ref([]);
const logs = ref([]);
const auditLogs = ref([]);
const autoRefresh = ref(true);
const statusError = ref("");
const statusLoading = ref(false);
const mappingVisible = ref(false);
const editingId = ref("");
const mappingDialogSaving = ref(false);
const savingMappingIds = ref(new Set());
const mappingForm = reactive({ name: "", serverPort: 2234, clientHost: "127.0.0.1", clientPort: 1234, enabled: true });

const title = computed(() => (props.mode === "server" ? t("dashboard.serverTitle") : t("dashboard.clientTitle")));
const subtitle = computed(() => (props.mode === "server" ? t("dashboard.serverSubtitle") : t("dashboard.clientSubtitle")));
const mainConnected = computed(() => (props.mode === "server" ? Boolean(status.value.client) : Boolean(status.value.connected)));
const identityText = computed(() => (props.mode === "server" ? status.value.client?.id || "-" : status.value.config?.clientId || "-"));
let refreshTimer = 0;

function applyStatus(data) {
  status.value = data;
  mappings.value = data.mappings || [];
  logs.value = data.logs || [];
  auditLogs.value = data.auditLogs || [];
}

async function loadStatus(options = {}) {
  const { silent = false } = options;
  statusLoading.value = true;
  try {
    applyStatus(await api.status());
    statusError.value = "";
  } catch (err) {
    statusError.value = err.message || t("config.saveFailed");
    if (!silent) ElMessage.error(statusError.value);
  } finally {
    statusLoading.value = false;
  }
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let size = Number(value || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatTime(value) {
  if (!value) return "-";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function statusText(value) {
  if (value === "connected") return t("dashboard.connected");
  if (value === "disabled") return t("dashboard.disabled");
  if (value === "error") return t("dashboard.errors");
  return t("dashboard.disconnected");
}

function statusClass(value) {
  if (value === "connected") return "online";
  if (value === "disabled") return "paused";
  if (value === "error") return "offline";
  return "offline";
}

function isMappingSaving(id) {
  return savingMappingIds.value.has(id);
}

function setMappingSaving(id, saving) {
  const next = new Set(savingMappingIds.value);
  if (saving) next.add(id);
  else next.delete(id);
  savingMappingIds.value = next;
}

function syncAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = 0;
  }
  if (autoRefresh.value) refreshTimer = window.setInterval(() => loadStatus({ silent: true }), 5000);
}

function openCreate() {
  editingId.value = "";
  Object.assign(mappingForm, { name: t("dashboard.webDefaultName"), serverPort: 2234, clientHost: "127.0.0.1", clientPort: 1234, enabled: true });
  mappingVisible.value = true;
}

function openEdit(row) {
  editingId.value = row.id;
  Object.assign(mappingForm, row);
  mappingVisible.value = true;
}

async function saveMapping(row, enabled) {
  const previousEnabled = !enabled;
  setMappingSaving(row.id, true);
  try {
    applyStatus(await api.updateMapping(row.id, row));
    ElMessage.success(t("dashboard.mappingSaved"));
  } catch (err) {
    row.enabled = previousEnabled;
    ElMessage.error(err.message || t("config.saveFailed"));
  } finally {
    setMappingSaving(row.id, false);
  }
}

async function saveMappingDialog() {
  mappingDialogSaving.value = true;
  try {
    const data = editingId.value ? await api.updateMapping(editingId.value, mappingForm) : await api.createMapping(mappingForm);
    applyStatus(data);
    mappingVisible.value = false;
    ElMessage.success(t("dashboard.mappingSaved"));
  } catch (err) {
    ElMessage.error(err.message || t("config.saveFailed"));
  } finally {
    mappingDialogSaving.value = false;
  }
}

async function deleteMapping(row) {
  try {
    await ElMessageBox.confirm(t("dashboard.deleteConfirm", { name: row.name }), t("dashboard.confirmDelete"), { type: "warning" });
    setMappingSaving(row.id, true);
    applyStatus(await api.deleteMapping(row.id));
    ElMessage.success(t("dashboard.mappingDeleted"));
  } catch (err) {
    if (err !== "cancel" && err !== "close") ElMessage.error(err.message || t("config.saveFailed"));
  } finally {
    setMappingSaving(row.id, false);
  }
}

watch(autoRefresh, syncAutoRefresh);

onMounted(() => {
  loadStatus({ silent: true });
  syncAutoRefresh();
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>
