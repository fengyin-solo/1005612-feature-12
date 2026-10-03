import { MODULE_BY_KEY } from '@/data/modules'
import { listReviews, listRows, resetRows, saveReviews, saveRows } from '@/data/local-store'
import {
  HEAT_TOLERANCE_GJ,
  METER_READING_METHODS,
} from '@/data/types'
import type {
  ActionResult,
  BatchVerifyInput,
  BatchVerifyResult,
  BillingReview,
  EntryRow,
  MeterReadingInput,
  ModuleMeta,
  OverviewResult,
  PageResult,
  VerifyGroupResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 严格流转模块（如热计量抄表）：动作只能从登记的来源状态发起，越级一律拒收。
  const allowedSources = meta.actionSources?.[action]
  if (allowedSources && !allowedSources.includes(current)) {
    return {
      ok: false,
      message: `「${action}」只能在${allowedSources.join('、')}状态下发起，当前为「${current}」，越级操作已拒收`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) || target.includes('异常'),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRowsSafe()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

function allRowsSafe(): Record<string, EntryRow[]> {
  const keys = [...MODULE_BY_KEY.keys()]
  return Object.fromEntries(keys.map((key) => [key, listRows(key)]))
}

// ---------------------------------------------------------------------------
// 热计量抄表：报送、批量核对、异常登记
// ---------------------------------------------------------------------------

const HEATMETER_KEY = 'heatmeter'

export type SubmitMeterPayload = MeterReadingInput & { 抄表日期: string }

/** 累计热量口径：非负有限数，最多保留四位小数；空值、文字、负数一律按无效值挡回。 */
export function parseHeatValue(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return { ok: false, message: '累计热量未填写' }
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return { ok: false, message: `累计热量「${text}」不是有效数值，已挡回` }
  }
  if (value < 0) {
    return { ok: false, message: `累计热量「${text}」为负值，不符合抄表口径，已挡回` }
  }
  return { ok: true, value: Number(value.toFixed(4)) }
}

/** 抄表日期必须落在登记的结算周期内，累计热量按结算周期分批对齐。 */
function periodAligned(date: string, period: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date.slice(0, 7) === period
}

function nowLabel(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 提交抄表报送：
 * - 只能从「待抄表」发起，越级拒收；
 * - 抄表人必须签字，抄表日期与结算周期对齐，两处累计热量都得是有效非负值；
 * - 同一计量表号同一结算周期重复报送只保留一条，重复的挡回。
 */
export function submitMeterReading(id: number, payload: SubmitMeterPayload): ActionResult {
  const rows = listRows(HEATMETER_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的热计量抄表记录` }
  }
  const row = rows[index]
  const code = String(row['抄表编号'] ?? id)
  if (String(row.status) !== '待抄表') {
    return {
      ok: false,
      message: `抄表记录 ${code} 当前为「${row.status}」，只能在待抄表状态提交，越级报送已拒收`,
    }
  }
  const reader = String(payload.抄表人 ?? '').trim()
  if (!reader) {
    return { ok: false, message: `抄表记录 ${code} 缺少抄表人签字，不能报送` }
  }
  const method = String(payload.抄表方式 ?? '').trim()
  if (!METER_READING_METHODS.includes(method as (typeof METER_READING_METHODS)[number])) {
    return { ok: false, message: `抄表记录 ${code} 的抄表方式不在既有口径（${METER_READING_METHODS.join('、')}）内` }
  }
  const period = String(row['结算周期'] ?? '')
  if (!periodAligned(String(payload.抄表日期 ?? ''), period)) {
    return {
      ok: false,
      message: `抄表记录 ${code} 的抄表日期 ${payload.抄表日期 || '未填'} 不在结算周期 ${period} 内，累计热量无法与周期对齐，已挡回`,
    }
  }
  const primary = parseHeatValue(payload.累计热量)
  if (!primary.ok) {
    return { ok: false, message: `抄表记录 ${code} 表显读数${primary.message}` }
  }
  const secondary = parseHeatValue(payload.复核热量)
  if (!secondary.ok) {
    return { ok: false, message: `抄表记录 ${code} 复核读数${secondary.message}` }
  }
  const meterNo = String(row['计量表号'] ?? '')
  const duplicated = rows.some(
    (item) =>
      Number(item.id) !== id &&
      String(item['计量表号'] ?? '') === meterNo &&
      String(item['结算周期'] ?? '') === period &&
      ['抄表中', '已核对'].includes(String(item.status)),
  )
  if (duplicated) {
    return { ok: false, message: `计量表 ${meterNo} 在 ${period} 已有抄表报送，重复报送只保留一条，本次已拒收` }
  }

  const updated: EntryRow = {
    ...row,
    累计热量: primary.value,
    复核热量: secondary.value,
    抄表方式: method,
    抄表日期: payload.抄表日期,
    抄表人: reader,
    status: '抄表中',
    pending: true,
    abnormal: false,
    抄表状态: '抄表中',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(HEATMETER_KEY, next)
  return { ok: true, message: `抄表记录 ${code} 已报送，当前状态「抄表中」，等待批量核对` }
}

/** 人工把一条抄表中记录登记为异常（如现场核表确认表计故障），结果同步到结算待复核清单。 */
export function markMeterReadingAbnormal(id: number, operator: string, reason: string): ActionResult {
  const checker = String(operator ?? '').trim()
  if (!checker) {
    return { ok: false, message: '登记异常需要核对人签字' }
  }
  const rows = listRows(HEATMETER_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的热计量抄表记录` }
  }
  const row = rows[index]
  const code = String(row['抄表编号'] ?? id)
  if (String(row.status) !== '抄表中') {
    return {
      ok: false,
      message: `抄表记录 ${code} 当前为「${row.status}」，异常登记只能在抄表中发起，越级操作已拒收`,
    }
  }
  const time = nowLabel()
  const updated: EntryRow = {
    ...row,
    status: '抄表异常',
    pending: false,
    abnormal: true,
    核对人: checker,
    核对时间: time,
    抄表状态: '抄表异常',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(HEATMETER_KEY, next)
  upsertBillingReview(updated, '异常待复核', reason || '人工核对标记异常')
  return { ok: true, message: `抄表记录 ${code} 已登记为「抄表异常」，并同步到结算待复核清单` }
}

/**
 * 批量核对：多选抄表中记录一次提交确认。
 * - 只能核对「抄表中」记录，整批里有越级的整批拒收；核对人必须签字；
 * - 按结算周期分组：组内抄表方式不一致的整组单列，状态保持抄表中；
 * - 其余记录沿用既有抄表口径比较两处累计热量：差值不超过 0.01 GJ 视为一致→已核对；
 *   超差或读到无效值→抄表异常；
 * - 核对结果逐条同步到热费结算的待复核清单（异常进异常待复核）。
 */
export function batchVerifyMeterReadings(input: BatchVerifyInput): BatchVerifyResult {
  const empty: BatchVerifyResult = {
    ok: false,
    message: '',
    groups: [],
    verifiedCount: 0,
    abnormalCount: 0,
    splitCount: 0,
  }
  const ids = [...new Set(input.ids)]
  if (ids.length === 0) {
    return { ...empty, message: '请先勾选要核对的抄表记录' }
  }
  const checker = String(input.核对人 ?? '').trim()
  if (!checker) {
    return { ...empty, message: '批量核对需要核对人签字后才能提交' }
  }

  const rows = listRows(HEATMETER_KEY)
  const selected = ids
    .map((id) => rows.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row))
  const missing = ids.filter((id) => !rows.some((row) => Number(row.id) === id))
  if (missing.length > 0) {
    return { ...empty, message: `抄表记录 ${missing.join('、')} 不存在，核对已拒收` }
  }
  const notReading = selected.filter((row) => String(row.status) !== '抄表中')
  if (notReading.length > 0) {
    return {
      ...empty,
      message: `抄表记录 ${notReading.map((row) => row['抄表编号']).join('、')} 不在抄表中状态，越级核对已拒收，请只勾选抄表中的记录`,
    }
  }
  const unsigned = selected.filter((row) => String(row['抄表人'] ?? '').trim() === '')
  if (unsigned.length > 0) {
    return {
      ...empty,
      message: `抄表记录 ${unsigned.map((row) => row['抄表编号']).join('、')} 缺少抄表人签字，不能提交核对`,
    }
  }

  const periodOrder: string[] = []
  const groupsMap = new Map<string, EntryRow[]>()
  for (const row of selected) {
    const period = String(row['结算周期'] ?? '未分周期')
    if (!groupsMap.has(period)) {
      groupsMap.set(period, [])
      periodOrder.push(period)
    }
    groupsMap.get(period)!.push(row)
  }

  const time = nowLabel()
  const nextRows = [...rows]
  const resultGroups: VerifyGroupResult[] = []
  let verifiedCount = 0
  let abnormalCount = 0
  let splitCount = 0

  const persist = (row: EntryRow, patch: Partial<EntryRow>): EntryRow => {
    const updated: EntryRow = {
      ...row,
      ...patch,
      核对人: checker,
      核对时间: time,
    }
    const realIndex = nextRows.findIndex((item) => Number(item.id) === Number(row.id))
    nextRows[realIndex] = updated
    return updated
  }

  for (const period of periodOrder) {
    const groupRows = groupsMap.get(period)!
    const methods = [...new Set(groupRows.map((row) => String(row['抄表方式'] ?? '')))]
    if (methods.length > 1) {
      // 抄表方式不一致：整组单列，不做状态流转，等拆批后再核对。
      splitCount += groupRows.length
      resultGroups.push({
        结算周期: period,
        ids: groupRows.map((row) => Number(row.id)),
        kind: 'split',
        methods,
        reason: `同周期内抄表方式不一致（${methods.join('、')}），整组单列，请按抄表方式拆批后重新核对`,
        rows: groupRows,
      })
      continue
    }

    const verified: EntryRow[] = []
    const abnormal: EntryRow[] = []
    for (const row of groupRows) {
      const primary = parseHeatValue(String(row['累计热量'] ?? ''))
      const secondary = parseHeatValue(String(row['复核热量'] ?? ''))
      let bad: string | null = null
      if (!primary.ok) {
        bad = primary.message
      } else if (!secondary.ok) {
        bad = secondary.message
      } else if (Math.abs(primary.value - secondary.value) > HEAT_TOLERANCE_GJ) {
        bad = `两处累计热量不一致，差值 ${Math.abs(primary.value - secondary.value).toFixed(2)} GJ`
      }
      if (bad) {
        const updated = persist(row, {
          status: '抄表异常',
          pending: false,
          abnormal: true,
          抄表状态: '抄表异常',
        })
        abnormal.push(updated)
      } else {
        const updated = persist(row, {
          status: '已核对',
          pending: false,
          abnormal: false,
          抄表状态: '已核对',
        })
        verified.push(updated)
      }
    }

    if (verified.length > 0) {
      verifiedCount += verified.length
      resultGroups.push({
        结算周期: period,
        ids: verified.map((row) => Number(row.id)),
        kind: 'verified',
        methods,
        reason: `抄表方式统一为「${methods[0]}」，两处累计热量差值均不超过 ${HEAT_TOLERANCE_GJ} GJ，核对通过`,
        rows: verified,
      })
      verified.forEach((row) => upsertBillingReview(row, '待复核', '两处累计热量一致'))
    }
    if (abnormal.length > 0) {
      abnormalCount += abnormal.length
      resultGroups.push({
        结算周期: period,
        ids: abnormal.map((row) => Number(row.id)),
        kind: 'abnormal',
        methods,
        reason: `两处累计热量不一致或为无效值，按既有抄表口径登记抄表异常`,
        rows: abnormal,
      })
      abnormal.forEach((row) => {
        const a = parseHeatValue(String(row['累计热量'] ?? ''))
        const b = parseHeatValue(String(row['复核热量'] ?? ''))
        const note =
          a.ok && b.ok
            ? `两处累计热量不一致，差值 ${Math.abs(a.value - b.value).toFixed(2)} GJ`
            : '累计热量为无效值'
        upsertBillingReview(row, '异常待复核', note)
      })
    }
  }

  saveRows(HEATMETER_KEY, nextRows)

  const parts: string[] = []
  if (verifiedCount > 0) parts.push(`核对通过 ${verifiedCount} 条`)
  if (abnormalCount > 0) parts.push(`抄表异常 ${abnormalCount} 条`)
  if (splitCount > 0) parts.push(`抄表方式不一致整组单列 ${splitCount} 条`)
  return {
    ok: abnormalCount === 0 && splitCount === 0,
    message: `本批共 ${ids.length} 条：${parts.join('，')}`,
    groups: resultGroups,
    verifiedCount,
    abnormalCount,
    splitCount,
  }
}

/** 把核对结果同步到热费结算的待复核清单；同一抄表记录只保留一条（以记录编号去重）。 */
function upsertBillingReview(row: EntryRow, result: BillingReview['核对结果'], note: string): void {
  const reviews = listReviews()
  const id = Number(row.id)
  const review: BillingReview = {
    id,
    计量表号: String(row['计量表号'] ?? ''),
    用户名称: String(row['用户名称'] ?? ''),
    结算周期: String(row['结算周期'] ?? ''),
    累计热量: asHeat(row['累计热量']),
    复核热量: asHeat(row['复核热量']),
    核对结果: result,
    核对人: String(row['核对人'] ?? ''),
    核对时间: String(row['核对时间'] ?? ''),
    备注: note,
  }
  const index = reviews.findIndex((item) => item.id === id)
  if (index >= 0) {
    reviews[index] = review
  } else {
    reviews.unshift(review)
  }
  saveReviews(reviews)
}

function asHeat(value: string | number | boolean | undefined): number | string {
  if (typeof value === 'number') {
    return value
  }
  const parsed = parseHeatValue(String(value ?? ''))
  return parsed.ok ? parsed.value : String(value ?? '')
}

export function listBillingReviews(): BillingReview[] {
  return listReviews()
}
