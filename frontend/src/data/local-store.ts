import { SEED_BILLING_REVIEWS } from './seed-reviews'
import { SEED_ROWS } from './seed'
import type { BillingReview, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：热计量抄表补入两处累计热量、抄表人签字等字段，旧版本里的占位示例值全部作废。
const STORAGE_KEY = 'district-heating:entries:v2'
const REVIEW_KEY = 'district-heating:billing-reviews:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeJSON<T>(key: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const parsed = readJSON<Partial<Record<string, EntryRow[]>>>(STORAGE_KEY, {})
  const merged: Record<string, EntryRow[]> = { ...fallback }
  for (const [key, value] of Object.entries(parsed)) {
    if (value) {
      merged[key] = value
    }
  }
  return merged
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  writeJSON(STORAGE_KEY, next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 结算侧待复核清单：由热计量核对结果同步，独立命名空间，不污染热费结算单数据。
let reviewCache: BillingReview[] | null = null

export function listReviews(): BillingReview[] {
  if (reviewCache === null) {
    reviewCache = readJSON<BillingReview[]>(REVIEW_KEY, SEED_BILLING_REVIEWS)
  }
  return reviewCache
}

export function saveReviews(reviews: BillingReview[]): void {
  reviewCache = reviews
  writeJSON(REVIEW_KEY, reviews)
}
