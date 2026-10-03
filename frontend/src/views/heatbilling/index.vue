<template>
  <section class="page" data-module="heatbilling">
    <header class="page-head">
      <div>
        <h2>热费结算管理</h2>
        <p class="page-desc">维护热费结算单，围绕结算编号、用户名称、结算周期、热价标准做登记、筛选与状态流转；抄表批量核对的结果先进入下方待复核清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记热费结算单</button>
        <button class="btn" type="button" @click="exportRows">导出热费结算清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="review-panel">
      <header class="review-head">
        <h3>抄表核对 · 待复核清单（{{ reviewQueue.length }}）</h3>
        <span class="muted">来自热计量抄表「已核对」批次，需结算侧复核后转入待核算；复核不通过退回抄表异常</span>
      </header>
      <table v-if="reviewQueue.length" class="data-table">
        <thead>
          <tr>
            <th>计量表号</th>
            <th>用户名称</th>
            <th>结算周期</th>
            <th>累计热量(GJ)</th>
            <th>抄表签字人</th>
            <th>核对时间</th>
            <th>复核操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviewQueue" :key="item.key">
            <td>{{ item.meterCode }}</td>
            <td>{{ item.userName }}</td>
            <td>{{ item.period }}</td>
            <td>{{ item.heat.toFixed(3) }}</td>
            <td>{{ item.signer || '—' }}</td>
            <td>{{ item.checkedAt }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="acceptItem(item.key)">转入待核算</button>
              <button class="link danger" type="button" @click="rejectItem(item.key)">复核不通过</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无待复核条目，已核对的抄表批次会出现在这里</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无热费结算数据，可先登记热费结算单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条热费结算记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  acceptReview,
  loadReviewQueue,
  rejectReview,
} from '@/api/heatmeter-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BillingReviewItem, EntryRow } from '@/data/types'

const meta = moduleMeta('heatbilling')
const columns = ["结算编号", "用户名称", "结算周期", "用热面积", "热价标准", "应缴金额", "缴费日期", "收费员", "结算状态"]
const actions = ["提交核算", "登记缴费", "办理减免"]
const statuses = ["待核算", "已核算", "已缴费", "已减免"]

const rows = ref<EntryRow[]>([])
const allRowsCache = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['结算编号', '用户名称', '结算周期']
const reviewQueue = ref<BillingReviewItem[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allRowsCache.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待复核条目', value: reviewQueue.value.length },
  { label: '待核算用户', value: allRowsCache.value.filter((row) => String(row.status) === '待核算').length },
  { label: '已缴费用户', value: allRowsCache.value.filter((row) => String(row.status) === '已缴费').length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '热费结算单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function acceptItem(key: string) {
  errorMessage.value = ''
  const result = acceptReview(key)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function rejectItem(key: string) {
  errorMessage.value = ''
  const result = rejectReview(key)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    allRowsCache.value = payload.items
    rows.value = payload.items
    total.value = payload.total
    reviewQueue.value = loadReviewQueue()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '热费结算列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.review-panel { border: 1px solid #b9d2ff; background: #f7faff; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.review-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.review-head h3 { margin: 0; font-size: 14px; }
.muted { color: var(--muted); font-size: 12px; }
.link.danger { color: #b42318; }
</style>
