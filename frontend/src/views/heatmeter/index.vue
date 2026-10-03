<template>
  <section class="page heatmeter-page" data-module="heatmeter">
    <header class="page-head">
      <div>
        <h2>热计量抄表管理</h2>
        <p class="page-desc">
          抄表按结算周期分批报送，抄表人签字后进入抄表中；支持多选批量核对，抄表方式不一致的周期整组单列，
          状态只按待抄表→抄表中→已核对/抄表异常流转，越级操作拒收。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出热计量抄表清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>计量表号 / 用户 / 抄表编号</span>
        <input v-model="keyword" placeholder="按关键字检索" />
      </label>
      <label class="filter-item">
        <span>结算周期</span>
        <select v-model="periodFilter">
          <option value="">全部周期</option>
          <option v-for="period in periodOptions" :key="period" :value="period">{{ period }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>抄表状态</span>
        <select v-model="statusFilter">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <label class="batch-check">
        <input type="checkbox" :checked="allReadingSelected" :disabled="!readingRows.length" @change="toggleSelectAll" />
        全选本页抄表中（{{ readingRows.length }} 条）
      </label>
      <span class="batch-count">已勾选 {{ selectedIds.size }} 条，仅抄表中记录可参与批量核对</span>
      <input
        v-model="checkerName"
        class="sign-input"
        type="text"
        placeholder="核对人签字（必填）"
      />
      <button class="btn primary" type="button" :disabled="!selectedIds.size" @click="submitBatchVerify">
        批量核对所选记录
      </button>
    </div>

    <p class="verify-note">
      核对口径：同一结算周期内抄表方式必须一致；两处读到的累计热量差值不超过 0.01 GJ 视为一致，超差登记抄表异常。
    </p>

    <table class="data-table heatmeter-table">
      <thead>
        <tr>
          <th class="col-check">勾选</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td class="col-check">
            <input
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              :disabled="String(row.status) !== '抄表中'"
              :title="String(row.status) === '抄表中' ? '加入批量核对' : '只有抄表中的记录可勾选'"
              @change="toggleOne(Number(row.id))"
            />
          </td>
          <td>{{ row['抄表编号'] || '—' }}</td>
          <td>{{ row['计量表号'] || '—' }}</td>
          <td>{{ row['用户名称'] || '—' }}</td>
          <td :class="{ 'heat-mismatch': isMismatch(row) }">{{ formatHeat(row['累计热量']) }}</td>
          <td :class="{ 'heat-mismatch': isMismatch(row) }">{{ formatHeat(row['复核热量']) }}</td>
          <td>{{ row['抄表方式'] || '—' }}</td>
          <td>{{ row['抄表日期'] || '—' }}</td>
          <td>{{ row['结算周期'] || '—' }}</td>
          <td>{{ row['抄表人'] || '—' }}</td>
          <td>{{ row['核对人'] || '—' }}</td>
          <td>{{ row['核对时间'] || '—' }}</td>
          <td>{{ row['抄表状态'] || row.status }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button v-if="String(row.status) === '待抄表'" class="link" type="button" @click="openSubmit(row)">
              提交抄表
            </button>
            <button v-if="String(row.status) === '抄表中'" class="link" type="button" @click="verifySingle(row)">
              确认核对
            </button>
            <button v-if="String(row.status) === '抄表中'" class="link danger" type="button" @click="abnormalSingle(row)">
              标记异常
            </button>
            <span v-else-if="String(row.status) !== '待抄表'" class="muted-link">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">当前条件下没有热计量抄表记录</td>
        </tr>
      </tbody>
    </table>

    <div v-if="batchResult" class="result-panel" :class="batchResult.ok ? 'panel-ok' : 'panel-warn'">
      <header class="result-head">
        <strong>{{ batchResult.message }}</strong>
        <button class="link" type="button" @click="batchResult = null">收起结果</button>
      </header>
      <div v-for="group in batchResult.groups" :key="group.kind + group.结算周期" class="result-group" :class="`group-${group.kind}`">
        <p class="group-title">
          结算周期 {{ group.结算周期 }} ·
          <template v-if="group.kind === 'verified'">核对通过 {{ group.rows.length }} 条</template>
          <template v-else-if="group.kind === 'abnormal'">抄表异常 {{ group.rows.length }} 条</template>
          <template v-else>整组单列 {{ group.rows.length }} 条</template>
        </p>
        <p class="group-reason">{{ group.reason }}</p>
        <p class="group-rows">
          <span v-for="row in group.rows" :key="String(row.id)" class="group-chip">
            {{ row['抄表编号'] }}（{{ row['计量表号'] }}）
          </span>
        </p>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条热计量抄表记录；核对结果会同步到热费结算的待复核清单</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="submitTarget" class="modal-mask" @click.self="closeSubmit">
      <div class="modal-card">
        <header class="modal-head">
          <h3>提交抄表报送 · {{ submitTarget['抄表编号'] }}</h3>
          <button class="link" type="button" @click="closeSubmit">关闭</button>
        </header>
        <div class="modal-meta">
          计量表号：{{ submitTarget['计量表号'] }} ｜ 用户：{{ submitTarget['用户名称'] }} ｜ 结算周期：{{ submitTarget['结算周期'] }}
        </div>
        <form class="modal-form" @submit.prevent="confirmSubmit">
          <label>
            <span>表显累计热量（GJ）</span>
            <input v-model="submitForm.累计热量" placeholder="例如 128.36" />
          </label>
          <label>
            <span>复核累计热量（GJ）</span>
            <input v-model="submitForm.复核热量" placeholder="第二次读数，两处须一致" />
          </label>
          <label>
            <span>抄表方式</span>
            <select v-model="submitForm.抄表方式">
              <option value="" disabled>请选择抄表方式</option>
              <option v-for="method in readingMethods" :key="method" :value="method">{{ method }}</option>
            </select>
          </label>
          <label>
            <span>抄表日期</span>
            <input v-model="submitForm.抄表日期" type="date" />
            <small class="field-hint">日期必须落在结算周期 {{ submitTarget['结算周期'] }} 内</small>
          </label>
          <label>
            <span>抄表人签字</span>
            <input v-model="submitForm.抄表人" type="text" placeholder="签字后才能报送" />
          </label>
          <p v-if="submitError" class="error-text">{{ submitError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeSubmit">取消</button>
            <button class="btn primary" type="submit">确认报送</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  batchVerifyMeterReadings,
  downloadEntries,
  listEntries,
  markMeterReadingAbnormal,
  moduleMeta,
  submitMeterReading,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import { METER_READING_METHODS } from '@/data/types'
import type { BatchVerifyResult, EntryRow } from '@/data/types'

const meta = moduleMeta('heatmeter')
const session = useSessionStore()
const columns = [
  '抄表编号',
  '计量表号',
  '用户名称',
  '累计热量',
  '复核热量',
  '抄表方式',
  '抄表日期',
  '结算周期',
  '抄表人',
  '核对人',
  '核对时间',
  '抄表状态',
]
const statuses = ['待抄表', '抄表中', '已核对', '抄表异常']
const readingMethods = METER_READING_METHODS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const keyword = ref('')
const periodFilter = ref('')
const statusFilter = ref('')
const selectedIds = ref<Set<number>>(new Set())
const checkerName = ref(session.operator)
const batchResult = ref<BatchVerifyResult | null>(null)

const stats = computed(() => [
  { label: '待抄表用户', value: countByStatus('待抄表') },
  { label: '抄表中用户', value: countByStatus('抄表中') },
  { label: '已核对用户', value: countByStatus('已核对') },
  { label: '异常表数', value: countByStatus('抄表异常') },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: countByStatus(status) })),
)

const periodOptions = computed(() =>
  [...new Set(rows.value.map((row) => String(row['结算周期'] ?? '')).filter(Boolean))].sort(),
)

const readingRows = computed(() => rows.value.filter((row) => String(row.status) === '抄表中'))
const allReadingSelected = computed(
  () => readingRows.value.length > 0 && readingRows.value.every((row) => selectedIds.value.has(Number(row.id))),
)

const submitTarget = ref<EntryRow | null>(null)
const submitError = ref('')
const submitForm = ref({
  累计热量: '',
  复核热量: '',
  抄表方式: '',
  抄表日期: '',
  抄表人: session.operator,
})

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function formatHeat(value: string | number | boolean): string {
  if (value === '' || value === null || value === undefined) {
    return '—'
  }
  const num = Number(value)
  return Number.isFinite(num) && String(value).trim() !== '' ? num.toFixed(2) : String(value)
}

function isMismatch(row: EntryRow): boolean {
  if (String(row.status) !== '抄表中' || row['累计热量'] === '' || row['复核热量'] === '') {
    return false
  }
  const a = Number(row['累计热量'])
  const b = Number(row['复核热量'])
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 0.01
}

function resetFilters() {
  keyword.value = ''
  periodFilter.value = ''
  statusFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function toggleOne(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? new Set(readingRows.value.map((row) => Number(row.id))) : new Set()
}

function submitBatchVerify() {
  errorMessage.value = ''
  const result = batchVerifyMeterReadings({ ids: [...selectedIds.value], 核对人: checkerName.value })
  if (!result.ok && result.verifiedCount === 0 && result.splitCount === 0 && result.abnormalCount === 0) {
    errorMessage.value = result.message
    batchResult.value = null
    return
  }
  batchResult.value = result
  if (result.ok) {
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
  }
  selectedIds.value = new Set()
  reload()
}

function verifySingle(row: EntryRow) {
  const result = batchVerifyMeterReadings({ ids: [Number(row.id)], 核对人: checkerName.value })
  if (result.verifiedCount === 0 && result.abnormalCount === 0 && result.splitCount === 0) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.ok ? '' : result.message
  batchResult.value = result
  selectedIds.value = new Set()
  reload()
}

function abnormalSingle(row: EntryRow) {
  if (!window.confirm(`确认把 ${row['抄表编号']}（${row['计量表号']}）登记为抄表异常？结果将进入结算待复核清单。`)) {
    return
  }
  const result = markMeterReadingAbnormal(Number(row.id), checkerName.value, '人工核对标记异常')
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reload()
}

function openSubmit(row: EntryRow) {
  submitTarget.value = row
  submitError.value = ''
  submitForm.value = {
    累计热量: '',
    复核热量: '',
    抄表方式: '',
    抄表日期: '',
    抄表人: session.operator,
  }
}

function closeSubmit() {
  submitTarget.value = null
  submitError.value = ''
}

function confirmSubmit() {
  if (!submitTarget.value) {
    return
  }
  const result = submitMeterReading(Number(submitTarget.value.id), { ...submitForm.value })
  if (!result.ok) {
    submitError.value = result.message
    return
  }
  submitError.value = ''
  submitTarget.value = null
  errorMessage.value = ''
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key)
    let items = payload.items
    const kw = keyword.value.trim()
    if (kw) {
      items = items.filter(
        (row) =>
          String(row['抄表编号'] ?? '').includes(kw) ||
          String(row['计量表号'] ?? '').includes(kw) ||
          String(row['用户名称'] ?? '').includes(kw),
      )
    }
    if (periodFilter.value) {
      items = items.filter((row) => String(row['结算周期'] ?? '') === periodFilter.value)
    }
    if (statusFilter.value) {
      items = items.filter((row) => String(row.status) === statusFilter.value)
    }
    rows.value = items
    total.value = items.length
    const validIds = new Set(items.filter((row) => String(row.status) === '抄表中').map((row) => Number(row.id)))
    selectedIds.value = new Set([...selectedIds.value].filter((id) => validIds.has(id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '热计量抄表列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.heatmeter-page .batch-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.batch-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.batch-count {
  color: var(--muted);
  font-size: 12px;
}
.sign-input {
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  min-width: 180px;
}
.verify-note {
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0 8px;
}
.col-check {
  width: 44px;
  text-align: center;
}
.heat-mismatch {
  color: #b42318;
  font-weight: 600;
}
.row-abnormal {
  background: #fef3f2;
}
.link.danger {
  color: #b42318;
}
.muted-link {
  color: #94a3b8;
  font-size: 12px;
}
.result-panel {
  margin-top: 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 10px 12px;
  background: #fff;
}
.panel-ok {
  border-color: #a6d5a6;
}
.panel-warn {
  border-color: #f0c36d;
  background: #fffaeb;
}
.result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.result-group {
  border-top: 1px dashed var(--border);
  padding: 6px 0;
}
.group-title {
  margin: 4px 0;
  font-size: 13px;
}
.group-verified .group-title {
  color: #177245;
}
.group-abnormal .group-title {
  color: #b42318;
}
.group-split .group-title {
  color: #b54708;
}
.group-reason {
  margin: 2px 0;
  font-size: 12px;
  color: var(--muted);
}
.group-rows {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 0;
}
.group-chip {
  font-size: 12px;
  background: #eef2f7;
  border-radius: 999px;
  padding: 2px 10px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 460px;
  background: #fff;
  border-radius: 10px;
  padding: 16px;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-head h3 {
  margin: 0;
  font-size: 15px;
}
.modal-meta {
  font-size: 12px;
  color: var(--muted);
  margin: 8px 0;
}
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modal-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.modal-form input,
.modal-form select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
  color: #1f2937;
}
.field-hint {
  color: #94a3b8;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
