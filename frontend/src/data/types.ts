/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 严格流转：登记后只有列出的当前状态允许执行该动作，未登记则沿用通用的非重复即可流转口径。 */
  actionSources?: Record<string, string[]>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 抄表方式：沿用既有抄表口径，结算周期内整组方式一致才能一次核对通过。 */
export const METER_READING_METHODS = ['人工抄表', '远程抄表', '现场抄表'] as const
export type MeterReadingMethod = (typeof METER_READING_METHODS)[number]

/** 两处读到的累计热量允许偏差（GJ）：表显末位四舍五入造成的差异按既有口径放行。 */
export const HEAT_TOLERANCE_GJ = 0.01

export type MeterReadingInput = {
  累计热量: string
  复核热量: string
  抄表方式: string
  抄表人: string
}

export type BatchVerifyInput = {
  ids: number[]
  核对人: string
}

export type VerifyGroupResult = {
  结算周期: string
  ids: number[]
  kind: 'verified' | 'abnormal' | 'split'
  methods: string[]
  /** 整组被单列（抄表方式不一致）或整组异常时给出的说明。 */
  reason: string
  rows: EntryRow[]
}

export type BatchVerifyResult = ActionResult & {
  groups: VerifyGroupResult[]
  verifiedCount: number
  abnormalCount: number
  splitCount: number
}

/** 结算侧待复核清单：核对结果（含异常）会同步成这里的一条记录。 */
export type BillingReview = {
  id: number
  计量表号: string
  用户名称: string
  结算周期: string
  累计热量: number | string
  复核热量: number | string
  核对结果: '待复核' | '异常待复核'
  核对人: string
  核对时间: string
  备注: string
}
