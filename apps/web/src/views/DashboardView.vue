<template>
  <AppShell :title="title" :subtitle="subtitle">
    <section class="metric-grid">
      <div class="metric-card">
        <div class="metric-label">{{ mode === "server" ? "客户端连接" : "服务端连接" }}</div>
        <div class="metric-value">
          <el-tag :type="mainConnected ? 'success' : 'danger'" effect="plain">{{ mainConnected ? "已连接" : "未连接" }}</el-tag>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">{{ mode === "server" ? "客户端" : "客户端 ID" }}</div>
        <div class="metric-value">{{ identityText }}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">映射数量</div>
        <div class="metric-value">{{ mappings.length }}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">{{ mode === "server" ? "待处理请求" : "最近错误" }}</div>
        <div class="metric-value">{{ mode === "server" ? status.pending || 0 : status.lastError || "-" }}</div>
      </div>
    </section>

    <section v-if="mode === 'server'" class="panel">
      <div class="panel-head"><h2>客户端连接情况</h2></div>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="客户端 ID">{{ status.client?.id || "-" }}</el-descriptions-item>
        <el-descriptions-item label="连接时间">{{ formatTime(status.client?.connectedAt) }}</el-descriptions-item>
        <el-descriptions-item label="心跳延迟">{{ status.client?.latencyMs ?? "-" }} ms</el-descriptions-item>
        <el-descriptions-item label="最后心跳">{{ formatTime(status.client?.lastPongAt) }}</el-descriptions-item>
      </el-descriptions>
    </section>

    <section v-if="mode === 'client'" class="panel">
      <div class="panel-head"><h2>服务端连接情况</h2></div>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="服务端 WebSocket 地址">{{ status.config?.serverUrl }}</el-descriptions-item>
        <el-descriptions-item label="客户端 ID">{{ status.config?.clientId }}</el-descriptions-item>
        <el-descriptions-item label="Token">{{ status.config?.tunnelToken ? "已设置" : "未设置" }}</el-descriptions-item>
        <el-descriptions-item label="最后心跳">{{ formatTime(status.lastServerPingAt) }}</el-descriptions-item>
        <el-descriptions-item label="重连间隔">{{ status.config?.reconnectMs }} ms</el-descriptions-item>
        <el-descriptions-item label="请求超时">{{ status.config?.requestTimeoutMs }} ms</el-descriptions-item>
        <el-descriptions-item label="管理 API 请求体上限">{{ status.config?.maxResponseBytes }}</el-descriptions-item>
      </el-descriptions>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>端口映射情况</h2>
        <div class="panel-actions">
          <el-switch v-model="autoRefresh" active-text="自动刷新" />
          <el-button @click="loadStatus">刷新</el-button>
          <el-button v-if="mode === 'client'" type="primary" @click="openCreate">新增映射</el-button>
        </div>
      </div>
      <el-table :data="mappings" stripe style="width: 100%">
        <el-table-column label="连接状态" width="130">
          <template #default="{ row }">
            <el-tag :type="row.status === 'connected' ? 'success' : row.status === 'disabled' ? 'warning' : 'danger'" effect="plain">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="serverPort" label="服务器端口" width="120" />
        <el-table-column prop="clientHost" label="客户端主机" min-width="140" />
        <el-table-column prop="clientPort" label="客户端端口" width="120" />
        <el-table-column label="请求数" width="90">
          <template #default="{ row }">{{ row.stats?.requestCount || 0 }}</template>
        </el-table-column>
        <el-table-column label="并发" width="80">
          <template #default="{ row }">{{ row.stats?.activeRequests || 0 }}</template>
        </el-table-column>
        <el-table-column label="错误" width="80">
          <template #default="{ row }">{{ row.stats?.errorCount || 0 }}</template>
        </el-table-column>
        <el-table-column label="流量" min-width="190">
          <template #default="{ row }">
            <span class="nowrap">{{ formatBytes(row.stats?.bytesIn || 0) }} / {{ formatBytes(row.stats?.bytesOut || 0) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实时速率" min-width="190">
          <template #default="{ row }">
            <span class="nowrap">{{ formatBytes(row.stats?.rateInBps || 0) }}/s / {{ formatBytes(row.stats?.rateOutBps || 0) }}/s</span>
          </template>
        </el-table-column>
        <el-table-column label="最近访问" min-width="170">
          <template #default="{ row }">{{ formatTime(row.stats?.lastAccessAt) }}</template>
        </el-table-column>
        <el-table-column v-if="mode === 'client'" label="启用" width="90">
          <template #default="{ row }"><el-switch v-model="row.enabled" @change="saveMapping(row)" /></template>
        </el-table-column>
        <el-table-column v-if="mode === 'client'" label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="deleteMapping(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>日志</h2></div>
      <div class="log-list">
        <el-empty v-if="!logs.length" description="暂无日志" />
        <div v-for="item in logs" :key="item.time + item.message" class="log-line">
          <code>{{ item.time }}</code>
          <el-tag :type="item.level === 'error' ? 'danger' : item.level === 'warn' ? 'warning' : 'success'" effect="plain">
            {{ item.level }}
          </el-tag>
          <span>{{ item.message }} <code>{{ JSON.stringify(item.data) }}</code></span>
        </div>
      </div>
    </section>

    <section v-if="mode === 'server'" class="panel">
      <div class="panel-head"><h2>审计日志</h2></div>
      <div class="log-list">
        <el-empty v-if="!auditLogs.length" description="暂无审计日志" />
        <div v-for="item in auditLogs" :key="item.id" class="log-line audit-line">
          <code>{{ item.time }}</code>
          <el-tag effect="plain">{{ item.event }}</el-tag>
          <span>{{ item.actor || "-" }} {{ item.ip || "" }} <code>{{ JSON.stringify(item.data) }}</code></span>
        </div>
      </div>
    </section>

    <el-dialog v-model="mappingVisible" :title="editingId ? '编辑端口映射' : '新增端口映射'" width="560px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="名称"><el-input v-model="mappingForm.name" /></el-form-item>
          <el-form-item label="服务器端口"><el-input-number v-model="mappingForm.serverPort" :min="1" class="full-input" /></el-form-item>
          <el-form-item label="客户端主机"><el-input v-model="mappingForm.clientHost" /></el-form-item>
          <el-form-item label="客户端端口"><el-input-number v-model="mappingForm.clientPort" :min="1" class="full-input" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="mappingForm.enabled" /></el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="mappingVisible = false">取消</el-button>
        <el-button type="primary" @click="saveMappingDialog">保存</el-button>
      </template>
    </el-dialog>
  </AppShell>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import AppShell from "./AppShell.vue";
import { api } from "../api/client.js";

const props = defineProps({
  mode: { type: String, required: true }
});

const status = ref({});
const mappings = ref([]);
const logs = ref([]);
const auditLogs = ref([]);
const autoRefresh = ref(true);
const mappingVisible = ref(false);
const editingId = ref("");
const mappingForm = reactive({ name: "", serverPort: 2234, clientHost: "127.0.0.1", clientPort: 1234, enabled: true });

const title = computed(() => (props.mode === "server" ? "HTTP Tunnel Server" : "HTTP Tunnel Client"));
const subtitle = computed(() => (props.mode === "server" ? "服务端 Dashboard" : "客户端 Dashboard"));
const mainConnected = computed(() => (props.mode === "server" ? Boolean(status.value.client) : Boolean(status.value.connected)));
const identityText = computed(() => (props.mode === "server" ? status.value.client?.id || "-" : status.value.config?.clientId || "-"));
let refreshTimer = 0;

function applyStatus(data) {
  status.value = data;
  mappings.value = data.mappings || [];
  logs.value = data.logs || [];
  auditLogs.value = data.auditLogs || [];
}

async function loadStatus() {
  applyStatus(await api.status());
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
  return new Date(value).toLocaleString();
}

function syncAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = 0;
  }
  if (autoRefresh.value) refreshTimer = window.setInterval(loadStatus, 5000);
}

function openCreate() {
  editingId.value = "";
  Object.assign(mappingForm, { name: "Web", serverPort: 2234, clientHost: "127.0.0.1", clientPort: 1234, enabled: true });
  mappingVisible.value = true;
}

function openEdit(row) {
  editingId.value = row.id;
  Object.assign(mappingForm, row);
  mappingVisible.value = true;
}

async function saveMapping(row) {
  applyStatus(await api.updateMapping(row.id, row));
  ElMessage.success("映射已保存");
}

async function saveMappingDialog() {
  const data = editingId.value ? await api.updateMapping(editingId.value, mappingForm) : await api.createMapping(mappingForm);
  applyStatus(data);
  mappingVisible.value = false;
  ElMessage.success("映射已保存");
}

async function deleteMapping(row) {
  await ElMessageBox.confirm(`删除映射 ${row.name}？`, "确认删除", { type: "warning" });
  applyStatus(await api.deleteMapping(row.id));
  ElMessage.success("映射已删除");
}

watch(autoRefresh, syncAutoRefresh);

onMounted(() => {
  loadStatus();
  syncAutoRefresh();
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>
