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

/** 抄表批量报送：逐条给出结论，重复报送只留一条。 */
export type HeatSubmitItem = {
  id: number
  ok: boolean
  reason: string
  deduped?: boolean
}

export type HeatSubmitResult = {
  ok: boolean
  message: string
  items: HeatSubmitItem[]
}

/** 批量核对：同组里抄表方式不一致的整组单列。 */
export type HeatCheckItem = {
  id: number
  ok: boolean
  reason: string
}

export type HeatSingledGroup = {
  id: string
  period: string
  methods: string[]
  rowIds: number[]
  createdAt: string
}

export type HeatCheckResult = {
  ok: boolean
  message: string
  passed: number
  abnormal: number
  items: HeatCheckItem[]
  singled: HeatSingledGroup
}

/** 已核对抄表转入结算侧的待复核清单。 */
export type BillingReviewItem = {
  key: string
  meterId: number
  meterCode: string
  userName: string
  period: string
  heat: number
  signer: string
  checkedAt: string
}
