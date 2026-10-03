<template>
  <section class="page" data-module="heatbilling">
    <header class="page-head">
      <div>
        <h2>热费结算管理</h2>
        <p class="page-desc">维护热费结算单，围绕结算编号、用户名称、用热面积、热价标准做登记、筛选与状态流转。</p>
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

    <h3 class="review-head">
      结算待复核清单
      <span class="review-count">共 {{ reviewRows.length }} 条，异常 {{ abnormalReviewCount }} 条</span>
    </h3>
    <p class="review-desc">热计量抄表核对结果会逐条同步到这里；同一抄表记录重复同步只保留一条。</p>
    <table class="data-table review-table">
      <thead>
        <tr>
          <th>抄表编号</th>
          <th>计量表号</th>
          <th>用户名称</th>
          <th>结算周期</th>
          <th>表显累计热量(GJ)</th>
          <th>复核累计热量(GJ)</th>
          <th>核对结果</th>
          <th>核对人</th>
          <th>核对时间</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="review in reviewRows" :key="String(review.id)" :class="{ 'review-abnormal': review.核对结果 === '异常待复核' }">
          <td>HEAT-{{ String(review.id).padStart(4, '0') }}</td>
          <td>{{ review.计量表号 }}</td>
          <td>{{ review.用户名称 }}</td>
          <td>{{ review.结算周期 }}</td>
          <td>{{ formatHeat(review.累计热量) }}</td>
          <td>{{ formatHeat(review.复核热量) }}</td>
          <td>{{ review.核对结果 }}</td>
          <td>{{ review.核对人 }}</td>
          <td>{{ review.核对时间 }}</td>
          <td>{{ review.备注 }}</td>
        </tr>
        <tr v-if="!reviewRows.length">
          <td colspan="10" class="empty-state">暂无待复核记录，先到热计量抄表完成核对</td>
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
  downloadEntries,
  listBillingReviews,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BillingReview, EntryRow } from '@/data/types'

const meta = moduleMeta('heatbilling')
const columns = ["结算编号", "用户名称", "用热面积", "热价标准", "应缴金额", "缴费日期", "收费员", "结算状态"]
const actions = ["提交核算", "登记缴费", "办理减免"]
const statuses = ["待核算", "已核算", "已缴费", "已减免"]
const stats = [{"label": "待核算用户", "value": 0}, {"label": "已缴费用户", "value": 0}, {"label": "本月应收金额", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reviewRows = ref<BillingReview[]>([])
const abnormalReviewCount = computed(() =>
  reviewRows.value.filter((review) => review.核对结果 === '异常待复核').length,
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function formatHeat(value: number | string): string {
  if (value === '' || value === null || value === undefined) {
    return '—'
  }
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(2) : String(value)
}

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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reviewRows.value = listBillingReviews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '热费结算列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.review-head {
  margin: 18px 0 4px;
  font-size: 15px;
}
.review-count {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}
.review-desc {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 8px;
}
.review-table {
  margin-bottom: 12px;
}
.review-abnormal {
  background: #fef3f2;
}
.review-abnormal td:nth-child(7) {
  color: #b42318;
  font-weight: 600;
}
</style>
