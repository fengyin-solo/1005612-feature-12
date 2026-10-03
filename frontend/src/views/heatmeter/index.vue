<template>
  <section class="page" data-module="heatmeter">
    <header class="page-head">
      <div>
        <h2>热计量抄表管理</h2>
        <p class="page-desc">月底抄表按结算周期分批报送与批量核对：累计热量两处读数一致并经抄表人签字后才转已核对，核对结果进入热费结算待复核清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出抄表清单</button>
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
      <label v-for="field in textFilterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>结算周期</span>
        <select v-model="filters['结算周期']">
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

    <section v-if="singledGroups.length" class="singled-panel">
      <h3>抄表方式不一致 · 单列批次（{{ singledGroups.length }}）</h3>
      <p class="panel-tip">以下批次组内抄表方式不统一，已整组单列不参与核对。请按抄表方式拆分后重新勾选核对。</p>
      <ul class="singled-list">
        <li v-for="group in singledGroups" :key="group.id">
          <div>
            <strong>{{ group.period }}</strong>
            <span class="tag">{{ group.methods.join(' / ') }}</span>
            <span class="muted">共 {{ group.rowIds.length }} 条 · {{ group.createdAt }}</span>
          </div>
          <div class="row-actions">
            <button class="link" type="button" @click="loadSingled(group.rowIds)">载入这组</button>
            <button class="link danger" type="button" @click="dismissSingled(group.id)">撤销单列</button>
          </div>
        </li>
      </ul>
    </section>

    <div v-if="selectedIds.length" class="batch-bar">
      <span>已选 <strong>{{ selectedIds.length }}</strong> 条（待抄表 {{ selectedPending }} · 抄表中 {{ selectedReading }}）</span>
      <span v-if="batchWarning" class="error-text">{{ batchWarning }}</span>
      <span class="batch-spacer"></span>
      <button class="btn" type="button" :disabled="!selectedPending" @click="batchSubmit">批量报送抄表</button>
      <button class="btn primary" type="button" :disabled="!selectedReading" @click="openCheck">批量核对确认</button>
      <button class="btn ghost" type="button" @click="clearSelection">清空选择</button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-cell">
            <input type="checkbox" :checked="allVisibleSelected" @change="toggleAll" aria-label="全选" />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'is-abnormal': row.abnormal }">
          <td class="check-cell">
            <input type="checkbox" :checked="isSelected(row)" @change="toggleOne(row)" aria-label="选择该记录" />
          </td>
          <td>{{ row['抄表编号'] }}</td>
          <td>{{ row['计量表号'] }}</td>
          <td>{{ row['用户名称'] }}</td>
          <td>{{ displayHeat(row['累计热量']) }}</td>
          <td>
            <template v-if="String(row.status) === '抄表中'">
              <input
                class="recheck-input"
                :value="String(row['复核累计热量'] ?? '')"
                placeholder="补录复核读数"
                @change="saveRecheck(row, ($event.target as HTMLInputElement).value)"
              />
            </template>
            <template v-else>{{ row['复核累计热量'] || '—' }}</template>
          </td>
          <td>{{ row['抄表方式'] }}</td>
          <td>{{ row['抄表人'] || '—' }}</td>
          <td>{{ row['抄表日期'] }}</td>
          <td>{{ row['结算周期'] }}</td>
          <td>
            <span :class="['status-pill', statusClass(row.status)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in legalActions(row.status)"
              :key="action"
              class="link"
              :class="{ danger: action === '标记异常' }"
              type="button"
              @click="runRowAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!legalActions(row.status).length" class="muted">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前筛选条件下没有抄表记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条抄表记录 · 流程：待抄表 → 抄表中 → 已核对，越级拒收，异常单列</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="feedback.length" class="feedback-panel">
      <header class="feedback-head">
        <strong>本次处理结果</strong>
        <button class="link" type="button" @click="feedback = []">关闭</button>
      </header>
      <ul>
        <li v-for="line in feedback" :key="line.id + line.text" :class="{ fail: !line.ok }">
          <span>{{ labelOf(line.id) }}</span>
          <span>{{ line.text }}</span>
        </li>
      </ul>
    </div>

    <div v-if="checkOpen" class="modal-mask" @click.self="closeCheck">
      <div class="modal">
        <h3>批量核对确认</h3>
        <p class="muted">核对批次：{{ checkSummary }}</p>
        <label class="sign-field">
          <span>抄表人签字 <em>*</em></span>
          <input v-model="signer" placeholder="请输入签字人姓名" />
        </label>
        <table class="data-table check-table">
          <thead>
            <tr>
              <th>抄表编号</th>
              <th>计量表号</th>
              <th>结算周期</th>
              <th>抄表方式</th>
              <th>现场累计热量</th>
              <th>复核累计热量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in checkRows" :key="String(row.id)">
              <td>{{ row['抄表编号'] }}</td>
              <td>{{ row['计量表号'] }}</td>
              <td>{{ row['结算周期'] }}</td>
              <td>{{ row['抄表方式'] }}</td>
              <td>{{ displayHeat(row['累计热量']) }}</td>
              <td>{{ row['复核累计热量'] || '未补录' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="checkError" class="error-text">{{ checkError }}</p>
        <ul v-if="checkFeedback.length" class="check-feedback">
          <li v-for="line in checkFeedback" :key="line.id" :class="{ fail: !line.ok }">{{ line.text }}</li>
        </ul>
        <footer class="modal-foot">
          <button class="btn ghost" type="button" @click="closeCheck">{{ checkFeedback.length ? '完成' : '取消' }}</button>
          <button class="btn primary" type="button" :disabled="!signer.trim()" @click="confirmCheck">
            签字并确认核对（{{ checkRows.length }} 条）
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  checkMeterReadings,
  legalMeterActions,
  loadSingledGroups,
  markMeterAbnormal,
  METER_STATUSES,
  parseHeat,
  removeSingledGroup,
  saveRecheckHeat,
  submitMeterReadings,
} from '@/api/heatmeter-service'
import { downloadEntries, listEntries } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { HeatSingledGroup } from '@/data/types'
import type { EntryRow } from '@/data/types'

const MODULE_KEY = 'heatmeter'
const columns = ['抄表编号', '计量表号', '用户名称', '累计热量', '复核累计热量', '抄表方式', '抄表人', '抄表日期', '结算周期']
const textFilterFields = ['抄表编号', '计量表号', '用户名称']
const statuses = [...METER_STATUSES]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const allRowsCache = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusFilter = ref('')
const selectedIds = ref<number[]>([])
const singledGroups = ref<HeatSingledGroup[]>([])
const feedback = ref<{ id: number; text: string; ok: boolean }[]>([])

const checkOpen = ref(false)
const signer = ref(session.operator)
const checkError = ref('')
const checkFeedback = ref<{ id: number; text: string; ok: boolean }[]>([])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: allRowsCache.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待抄表用户', value: countStatus('待抄表') },
  { label: '抄表中用户', value: countStatus('抄表中') },
  { label: '已核对用户', value: countStatus('已核对') },
  { label: '异常表数', value: countStatus('抄表异常') },
])

function countStatus(status: string): number {
  return allRowsCache.value.filter((row) => String(row.status) === status).length
}

const periodOptions = computed(() =>
  [...new Set(allRowsCache.value.map((row) => String(row['结算周期'] ?? '')).filter(Boolean))].sort().reverse(),
)

const visibleIds = computed(() => rows.value.map((row) => Number(row.id)))
const allVisibleSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)
const selectedRows = computed(() =>
  selectedIds.value
    .map((id) => allRowsCache.value.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row)),
)
const selectedPending = computed(() => selectedRows.value.filter((row) => String(row.status) === '待抄表').length)
const selectedReading = computed(() => selectedRows.value.filter((row) => String(row.status) === '抄表中').length)
const batchWarning = computed(() => {
  const other = selectedRows.value.filter(
    (row) => !['待抄表', '抄表中'].includes(String(row.status)),
  )
  return other.length ? `已核对/抄表异常的 ${other.length} 条不参与批量操作` : ''
})

const checkRows = computed(() =>
  selectedIds.value
    .map((id) => allRowsCache.value.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => row !== undefined && String(row.status) === '抄表中'),
)
const checkSummary = computed(() => {
  const picked = checkRows.value
  if (!picked.length) {
    return '—'
  }
  const periods = [...new Set(picked.map((row) => String(row['结算周期'])))]
  const methods = [...new Set(picked.map((row) => String(row['抄表方式'])))]
  return `${periods.join('、')} · ${methods.join(' / ')} · ${picked.length} 条`
})

function isSelected(row: EntryRow): boolean {
  return selectedIds.value.includes(Number(row.id))
}

function toggleOne(row: EntryRow) {
  const id = Number(row.id)
  if (isSelected(row)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const visible = visibleIds.value
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, ...visible])]
    : selectedIds.value.filter((id) => !visible.includes(id))
}

function clearSelection() {
  selectedIds.value = []
}

function legalActions(status: string): string[] {
  return legalMeterActions(String(status))
}

function displayHeat(raw: unknown): string {
  return parseHeat(raw) === null ? `⚠ ${String(raw ?? '')}` : String(raw)
}

function statusClass(status: string): string {
  if (status === '已核对') {
    return 'pill-ok'
  }
  if (status === '抄表异常') {
    return 'pill-abnormal'
  }
  if (status === '抄表中') {
    return 'pill-doing'
  }
  return 'pill-todo'
}

function labelOf(id: number): string {
  const row = allRowsCache.value.find((item) => Number(item.id) === id)
  return row ? String(row['抄表编号']) : `#${id}`
}

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(MODULE_KEY)
}

function pruneSelection() {
  const validIds = allRowsCache.value.map((row) => Number(row.id))
  selectedIds.value = selectedIds.value.filter((id) => validIds.includes(id))
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(MODULE_KEY, filters.value)
    allRowsCache.value = payload.items
    rows.value = statusFilter.value
      ? payload.items.filter((row) => String(row.status) === statusFilter.value)
      : payload.items
    total.value = payload.total
    pruneSelection()
    singledGroups.value = loadSingledGroups()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '抄表列表读取失败'
  }
}

function batchSubmit() {
  const ids = selectedRows.value.filter((row) => String(row.status) === '待抄表').map((row) => Number(row.id))
  if (!ids.length) {
    errorMessage.value = '所选记录里没有待抄表的记录'
    return
  }
  const result = submitMeterReadings(ids)
  feedback.value = result.items.map((item) => ({ id: item.id, text: item.reason, ok: item.ok }))
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function saveRecheck(row: EntryRow, value: string) {
  const result = saveRecheckHeat(Number(row.id), value)
  errorMessage.value = result.ok ? '' : result.message
  if (result.ok) {
    reload()
  }
}

function runRowAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '提交抄表') {
    const result = submitMeterReadings([Number(row.id)])
    feedback.value = result.items.map((item) => ({ id: item.id, text: item.reason, ok: item.ok }))
    errorMessage.value = result.ok ? '' : result.message
  } else if (action === '标记异常') {
    const result = markMeterAbnormal(Number(row.id))
    feedback.value = [{ id: Number(row.id), text: result.message, ok: result.ok }]
    errorMessage.value = result.ok ? '' : result.message
  } else if (action === '确认核对') {
    selectedIds.value = [Number(row.id)]
    openCheck()
  }
  reload()
}

function openCheck() {
  if (!selectedReading.value) {
    errorMessage.value = '所选记录里没有抄表中的记录，无法核对'
    return
  }
  checkError.value = ''
  checkFeedback.value = []
  checkOpen.value = true
}

function closeCheck() {
  checkOpen.value = false
  checkError.value = ''
  checkFeedback.value = []
  reload()
}

function confirmCheck() {
  checkError.value = ''
  const result = checkMeterReadings(checkRows.value.map((row) => Number(row.id)), signer.value)
  checkFeedback.value = result.items.map((item) => ({ id: item.id, text: item.reason, ok: item.ok }))
  if (result.singled.id) {
    singledGroups.value = loadSingledGroups()
  }
  if (!result.ok) {
    checkError.value = result.message
    if (result.singled.id) {
      checkFeedback.value = result.items.map((item) => ({ id: item.id, text: item.reason, ok: item.ok }))
    }
  }
  reload()
}

function loadSingled(ids: number[]) {
  filters.value = {}
  statusFilter.value = '抄表中'
  selectedIds.value = ids
  reload()
}

function dismissSingled(groupId: string) {
  singledGroups.value = removeSingledGroup(groupId)
}

onMounted(reload)
</script>

<style scoped>
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #eef4ff;
  border: 1px solid #b9d2ff;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
.batch-spacer { flex: 1; }
.check-cell { width: 36px; text-align: center; }
.recheck-input { width: 110px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; }
.muted { color: var(--muted); }
.link.danger { color: #b42318; }
.is-abnormal { background: #fff6f5; }
.status-pill { border-radius: 999px; padding: 1px 10px; font-size: 12px; }
.pill-todo { background: #eef2f7; color: #475569; }
.pill-doing { background: #fef3c7; color: #92400e; }
.pill-ok { background: #dcfce7; color: #166534; }
.pill-abnormal { background: #fee2e2; color: #b42318; }
.singled-panel { border: 1px solid #f0b4ad; background: #fff8f7; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.singled-panel h3 { margin: 0 0 4px; font-size: 14px; color: #b42318; }
.panel-tip { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.singled-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.singled-list li { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.tag { background: #fee2e2; color: #b42318; border-radius: 4px; padding: 0 8px; margin: 0 8px; font-size: 12px; }
.feedback-panel { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; background: #fff; padding: 10px 12px; }
.feedback-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 13px; }
.feedback-panel ul { margin: 0; padding-left: 18px; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.feedback-panel li.fail { color: #b42318; }
.feedback-panel li span:first-child { font-weight: 600; margin-right: 6px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 10px; width: 760px; max-width: calc(100vw - 40px); max-height: 82vh; overflow: auto; padding: 16px 18px; }
.modal h3 { margin: 0 0 4px; }
.sign-field { display: block; margin: 10px 0; }
.sign-field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.sign-field input { width: 260px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.sign-field em { color: #b42318; font-style: normal; }
.check-table { margin: 8px 0; }
.check-feedback { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.check-feedback li.fail { color: #b42318; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
