import { listRows, readAux, saveRows, writeAux } from '@/data/local-store'
import type {
  BillingReviewItem,
  EntryRow,
  HeatCheckResult,
  HeatSingledGroup,
  HeatSubmitResult,
} from '@/data/types'

// 抄表口径沿用既有的 GJ 读数：非负数值、最多三位小数。
const HEAT_PATTERN = /^\d+(\.\d{1,3})?$/
const HEAT_KEY = '累计热量'
const RECHECK_HEAT_KEY = '复核累计热量'
const METER_CODE_KEY = '计量表号'
const PERIOD_KEY = '结算周期'
const METHOD_KEY = '抄表方式'
const READ_DATE_KEY = '抄表日期'
const SIGNER_KEY = '抄表人'

export const METER_STATUSES = ['待抄表', '抄表中', '已核对', '抄表异常'] as const
export const METER_METHODS = ['人工抄表', '远传抄表', '估抄'] as const

const SINGLED_KEY = 'heatmeter:singled-groups'
const REVIEW_KEY = 'heatbilling:review-queue'

/** 按既有抄表口径解析累计热量，无效值返回 null。 */
export function parseHeat(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!HEAT_PATTERN.test(text)) {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** 累计热量（GJ，三位小数）的展示口径，无效输入原样返回。 */
export function formatHeat(raw: unknown): string {
  const value = parseHeat(raw)
  return value === null ? String(raw ?? '') : value.toFixed(3)
}

/** 结算周期形如 2026-10；抄表日期必须落在该周期月份内。 */
export function periodMatchesDate(period: unknown, date: unknown): boolean {
  return String(date ?? '').startsWith(`${String(period ?? '')}-`)
}

/** 抄表按 待抄表 → 抄表中 → 已核对 逐级流转，标记异常只能从抄表中提出；越级拒收。 */
export function legalMeterTarget(status: string, action: string): string | null {
  if (action === '提交抄表') {
    return status === '待抄表' ? '抄表中' : null
  }
  if (action === '确认核对') {
    return status === '抄表中' ? '已核对' : null
  }
  if (action === '标记异常') {
    return status === '抄表中' ? '抄表异常' : null
  }
  return null
}

/** 单条记录当前状态下允许的动作，页面按这个渲染按钮，不允许越级操作。 */
export function legalMeterActions(status: string): string[] {
  if (status === '待抄表') {
    return ['提交抄表']
  }
  if (status === '抄表中') {
    return ['确认核对', '标记异常']
  }
  return []
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function markStatus(rows: EntryRow[], id: number, status: string, patch: Record<string, string>): void {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return
  }
  const abnormal = status === '抄表异常'
  rows[index] = {
    ...rows[index],
    ...patch,
    status,
    pending: status === '待抄表' || status === '抄表中',
    abnormal,
  }
}

/**
 * 批量（或单条）报送抄表：
 * 只收待抄表；结算周期与抄表日期要对齐；累计热量无效值挡回；
 * 同一计量表号 + 结算周期重复报送只留一条。
 */
export function submitMeterReadings(ids: number[]): HeatSubmitResult {
  const rows = listRows('heatmeter')
  const items: HeatSubmitResult['items'] = []
  let accepted = 0

  for (const id of ids) {
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) {
      items.push({ id, ok: false, reason: '记录不存在' })
      continue
    }
    if (String(row.status) !== '待抄表') {
      items.push({ id, ok: false, reason: `当前为「${row.status}」，不能重复报送（越级拒收）` })
      continue
    }
    if (!periodMatchesDate(row[PERIOD_KEY], row[READ_DATE_KEY])) {
      items.push({
        id,
        ok: false,
        reason: `抄表日期 ${row[READ_DATE_KEY]} 不属于结算周期 ${row[PERIOD_KEY]}`,
      })
      continue
    }
    if (parseHeat(row[HEAT_KEY]) === null) {
      items.push({ id, ok: false, reason: `累计热量「${row[HEAT_KEY]}」不是有效读数（GJ，最多三位小数），已挡回` })
      continue
    }
    const duplicate = rows.find(
      (item) =>
        Number(item.id) !== id &&
        String(item[METER_CODE_KEY]) === String(row[METER_CODE_KEY]) &&
        String(item[PERIOD_KEY]) === String(row[PERIOD_KEY]) &&
        (String(item.status) === '抄表中' || String(item.status) === '已核对'),
    )
    if (duplicate) {
      items.push({
        id,
        ok: false,
        deduped: true,
        reason: `计量表号 ${row[METER_CODE_KEY]} 在 ${row[PERIOD_KEY]} 已报送（见编号 ${duplicate['抄表编号']}），重复报送只留一条`,
      })
      continue
    }
    markStatus(rows, id, '抄表中', {})
    accepted += 1
    items.push({ id, ok: true, reason: '报送成功，进入抄表中' })
  }

  saveRows('heatmeter', rows)
  return {
    ok: accepted > 0,
    message:
      accepted > 0
        ? `报送完成：${accepted} 条进入「抄表中」，${items.length - accepted} 条未受理`
        : '本次报送没有可受理的记录',
    items,
  }
}

/**
 * 批量核对一组抄表记录，需要抄表人签字：
 * 1) 必须同属一个结算周期（抄表按周期分批）；
 * 2) 组内抄表方式不一致的整组单列，不参与本次核对；
 * 3) 累计热量/复核累计热量沿用既有口径，无效值挡回；
 * 4) 两处读数不一致的落到「抄表异常」；
 * 5) 通过的转为「已核对」并进结算侧待复核清单。
 */
export function checkMeterReadings(ids: number[], signer: string): HeatCheckResult {
  const signerName = signer.trim()
  if (ids.length === 0) {
    return {
      ok: false,
      message: '请先勾选要核对的抄表记录',
      passed: 0,
      abnormal: 0,
      items: [],
      singled: { id: '', period: '', methods: [], rowIds: [], createdAt: '' },
    }
  }
  if (!signerName) {
    return {
      ok: false,
      message: '抄表人必须签字后才能确认核对',
      passed: 0,
      abnormal: 0,
      items: [],
      singled: { id: '', period: '', methods: [], rowIds: [], createdAt: '' },
    }
  }

  const rows = listRows('heatmeter')
  const picked = rows.filter((row) => ids.includes(Number(row.id)))
  const missing = ids.filter((id) => !picked.some((row) => Number(row.id) === id))
  if (missing.length > 0) {
    return {
      ok: false,
      message: `编号 ${missing.join('、')} 的记录不存在`,
      passed: 0,
      abnormal: 0,
      items: [],
      singled: { id: '', period: '', methods: [], rowIds: [], createdAt: '' },
    }
  }

  const notReading = picked.filter((row) => String(row.status) !== '抄表中')
  if (notReading.length > 0) {
    return {
      ok: false,
      message: `只有「抄表中」的记录才能核对，选中的 ${notReading
        .map((row) => row['抄表编号'])
        .join('、')} 不在该状态（越级拒收）`,
      passed: 0,
      abnormal: 0,
      items: [],
      singled: { id: '', period: '', methods: [], rowIds: [], createdAt: '' },
    }
  }

  const periods = [...new Set(picked.map((row) => String(row[PERIOD_KEY])))]
  if (periods.length > 1) {
    return {
      ok: false,
      message: `抄表按结算周期分批，不能跨期核对，请拆成 ${periods.join('、')} 两批`,
      passed: 0,
      abnormal: 0,
      items: [],
      singled: { id: '', period: '', methods: [], rowIds: [], createdAt: '' },
    }
  }
  const period = periods[0]

  const methods = [...new Set(picked.map((row) => String(row[METHOD_KEY])))]
  const singledEmpty: HeatSingledGroup = {
    id: '',
    period: '',
    methods: [],
    rowIds: [],
    createdAt: '',
  }
  if (methods.length > 1) {
    const group: HeatSingledGroup = {
      id: `${period.replace(/\D/g, '')}-${Date.now()}`,
      period,
      methods,
      rowIds: picked.map((row) => Number(row.id)),
      createdAt: nowText(),
    }
    const groups = loadSingledGroups().filter((item) => item.id !== group.id)
    groups.unshift(group)
    writeAux(SINGLED_KEY, groups)
    return {
      ok: false,
      passed: 0,
      abnormal: 0,
      message: `同组抄表方式不一致（${methods.join(' / ')}），整组 ${picked.length} 条已单列，未做核对`,
      items: picked.map((row) => ({
        id: Number(row.id),
        ok: false,
        reason: `抄表方式与组内其他记录不一致（本组：${methods.join(' / ')}），整组单列`,
      })),
      singled: group,
    }
  }

  const items: HeatCheckResult['items'] = []
  let passed = 0
  let abnormal = 0
  const checkedAt = nowText()

  for (const row of picked) {
    const id = Number(row.id)
    if (!periodMatchesDate(row[PERIOD_KEY], row[READ_DATE_KEY])) {
      markStatus(rows, id, '抄表异常', {})
      abnormal += 1
      items.push({
        id,
        ok: false,
        reason: `抄表日期 ${row[READ_DATE_KEY]} 不属于结算周期 ${row[PERIOD_KEY]}，转入异常`,
      })
      continue
    }
    const fieldHeat = parseHeat(row[HEAT_KEY])
    if (fieldHeat === null) {
      items.push({
        id,
        ok: false,
        reason: `现场累计热量「${row[HEAT_KEY]}」是无效值（GJ，最多三位小数），已挡回`,
      })
      continue
    }
    const recheckRaw = row[RECHECK_HEAT_KEY]
    const hasRecheck = String(recheckRaw ?? '').trim() !== ''
    if (!hasRecheck) {
      items.push({
        id,
        ok: false,
        reason: '缺少复核处累计热量，两处读数无法比对，已挡回',
      })
      continue
    }
    const recheckHeat = parseHeat(recheckRaw)
    if (recheckHeat === null) {
      items.push({
        id,
        ok: false,
        reason: `复核累计热量「${recheckRaw}」是无效值（GJ，最多三位小数），已挡回`,
      })
      continue
    }
    if (fieldHeat !== recheckHeat) {
      markStatus(rows, id, '抄表异常', {})
      abnormal += 1
      items.push({
        id,
        ok: false,
        reason: `两处累计热量不一致：现场 ${formatHeat(fieldHeat)} ≠ 复核 ${formatHeat(
          recheckHeat,
        )}，转入抄表异常`,
      })
      continue
    }
    markStatus(rows, id, '已核对', {
      [HEAT_KEY]: formatHeat(fieldHeat),
      [RECHECK_HEAT_KEY]: formatHeat(recheckHeat),
      [SIGNER_KEY]: signerName,
      核对时间: checkedAt,
    })
    passed += 1
    items.push({ id, ok: true, reason: `两处读数一致（${formatHeat(fieldHeat)} GJ），已核对并签字` })
  }

  saveRows('heatmeter', rows)
  if (passed > 0) {
    enqueueReview(
      rows.filter((row) => picked.some((item) => item.id === row.id) && String(row.status) === '已核对'),
      checkedAt,
    )
  }

  return {
    ok: passed > 0,
    passed,
    abnormal,
    message:
      passed > 0
        ? `核对完成：${passed} 条已核对并进入结算待复核，${abnormal} 条异常，${
            items.length - passed - abnormal
          } 条挡回`
        : `核对未通过：${abnormal} 条异常，其余被挡回`,
    items,
    singled: singledEmpty,
  }
}

/** 抄表中补录复核处的第二处读数；仍按既有口径校验，无效值挡回。 */
export function saveRecheckHeat(id: number, raw: string): { ok: boolean; message: string } {
  const text = raw.trim()
  if (text === '') {
    return { ok: false, message: '请填写复核累计热量' }
  }
  if (parseHeat(text) === null) {
    return { ok: false, message: '复核累计热量必须是非负数、最多三位小数（GJ）' }
  }
  const rows = listRows('heatmeter')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: '记录不存在' }
  }
  if (String(row.status) !== '抄表中') {
    return { ok: false, message: '只有抄表中的记录可以补录复核读数' }
  }
  const index = rows.indexOf(row)
  rows[index] = { ...row, [RECHECK_HEAT_KEY]: formatHeat(text) }
  saveRows('heatmeter', rows)
  return { ok: true, message: '复核累计热量已补录' }
}

/** 从抄表中直接标记异常（如表具故障无法读数）。 */
export function markMeterAbnormal(id: number): { ok: boolean; message: string } {
  const rows = listRows('heatmeter')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: '记录不存在' }
  }
  if (String(row.status) !== '抄表中') {
    return { ok: false, message: `当前为「${row.status}」，只有抄表中的记录可以标记异常（越级拒收）` }
  }
  markStatus(rows, id, '抄表异常', {})
  saveRows('heatmeter', rows)
  return { ok: true, message: '已标记为抄表异常' }
}

export function loadSingledGroups(): HeatSingledGroup[] {
  return readAux<HeatSingledGroup[]>(SINGLED_KEY, () => [])
}

export function removeSingledGroup(groupId: string): HeatSingledGroup[] {
  const groups = loadSingledGroups().filter((group) => group.id !== groupId)
  writeAux(SINGLED_KEY, groups)
  return groups
}

/** 结算侧待复核清单：首次没有存档时，从播种数据里已核对的抄表记录回填。 */
export function loadReviewQueue(): BillingReviewItem[] {
  return readAux<BillingReviewItem[]>(REVIEW_KEY, () =>
    listRows('heatmeter')
      .filter((row) => String(row.status) === '已核对')
      .map((row) => ({
        key: `${String(row[METER_CODE_KEY])}|${String(row[PERIOD_KEY])}`,
        meterId: Number(row.id),
        meterCode: String(row[METER_CODE_KEY]),
        userName: String(row['用户名称']),
        period: String(row[PERIOD_KEY]),
        heat: parseHeat(row[HEAT_KEY]) ?? 0,
        signer: String(row[SIGNER_KEY] ?? ''),
        checkedAt: String(row['核对时间'] ?? '播种数据'),
      })),
  )
}

function saveReviewQueue(queue: BillingReviewItem[]): void {
  writeAux(REVIEW_KEY, queue)
}

function enqueueReview(checkedRows: EntryRow[], checkedAt: string): void {
  const queue = loadReviewQueue()
  for (const row of checkedRows) {
    const key = `${String(row[METER_CODE_KEY])}|${String(row[PERIOD_KEY])}`
    const heat = parseHeat(row[HEAT_KEY]) ?? 0
    const existing = queue.findIndex((item) => item.key === key)
    const item: BillingReviewItem = {
      key,
      meterId: Number(row.id),
      meterCode: String(row[METER_CODE_KEY]),
      userName: String(row['用户名称']),
      period: String(row[PERIOD_KEY]),
      heat,
      signer: String(row[SIGNER_KEY] ?? ''),
      checkedAt,
    }
    if (existing >= 0) {
      queue[existing] = item
    } else {
      queue.unshift(item)
    }
  }
  saveReviewQueue(queue)
}

/** 结算侧受理待复核条目：按 用户名称 + 结算周期 落进结算单（待核算）。 */
export function acceptReview(key: string): { ok: boolean; message: string } {
  const queue = loadReviewQueue()
  const item = queue.find((entry) => entry.key === key)
  if (!item) {
    return { ok: false, message: '待复核条目不存在，可能已处理' }
  }
  const billing = listRows('heatbilling')
  const index = billing.findIndex(
    (row) => String(row['用户名称']) === item.userName && String(row[PERIOD_KEY]) === item.period,
  )
  if (index >= 0) {
    billing[index] = {
      ...billing[index],
      status: '待核算',
      pending: true,
      abnormal: false,
      结算周期: item.period,
    }
  } else {
    const nextId = (billing.reduce((max, row) => Math.max(max, Number(row.id)), 0) || 0) + 1
    billing.unshift({
      id: nextId,
      status: '待核算',
      pending: true,
      abnormal: false,
      结算编号: `SETT-${String(nextId).padStart(4, '0')}`,
      用户名称: item.userName,
      结算周期: item.period,
      用热面积: '待核算',
      热价标准: '待核算',
      应缴金额: '待核算',
      缴费日期: '—',
      收费员: item.signer || '待分配',
      结算状态: '待核算',
      关联表号: item.meterCode,
      累计热量: item.heat.toFixed(3),
    })
  }
  saveRows('heatbilling', billing)
  saveReviewQueue(queue.filter((entry) => entry.key !== key))
  return { ok: true, message: `${item.userName} ${item.period} 已转入结算待核算清单` }
}

/** 结算侧复核不通过：抄表记录退回抄表异常并移出待复核清单。 */
export function rejectReview(key: string): { ok: boolean; message: string } {
  const queue = loadReviewQueue()
  const item = queue.find((entry) => entry.key === key)
  if (!item) {
    return { ok: false, message: '待复核条目不存在，可能已处理' }
  }
  const meterRows = listRows('heatmeter')
  const index = meterRows.findIndex((row) => Number(row.id) === item.meterId)
  if (index >= 0) {
    meterRows[index] = {
      ...meterRows[index],
      status: '抄表异常',
      pending: false,
      abnormal: true,
      退回原因: '结算复核不通过',
    }
    saveRows('heatmeter', meterRows)
  }
  saveReviewQueue(queue.filter((entry) => entry.key !== key))
  return { ok: true, message: `${item.userName} ${item.period} 复核不通过，抄表记录已退回抄表异常` }
}
