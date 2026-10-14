/** Payload of GET /api/assets/dashboard (backend/app/engines/assetsx.py). */

export type PeriodKey = 'this_fy' | 'last_fy' | 'this_quarter' | 'this_month' | 'last_30' | 'custom'
export type CompareKey = 'none' | 'previous' | 'last_year'
export type DueWindow = 7 | 30 | 60 | 90
export type DueKind = 'calibration' | 'pm' | 'electrical_safety' | 'warranty' | 'amc'
export type Urgency = 'overdue' | 'due7' | 'due_window'

export interface CountRow { key: string | null; label: string; count: number; pct: number; more?: number }

export interface AssetBrief {
  id: string
  code: string | null
  name: string | null
  model?: string | null
  make?: string | null
  category?: string | null
  department: string | null
  department_id?: string | null
  status?: string | null
  criticality?: string | null
  location?: string | null
  location_status?: string | null
}

export interface Flow {
  key: string
  label: string
  format: 'number' | 'hours' | 'currency' | 'percent'
  better: 'up' | 'down' | 'neutral'
  value: number | null
  previous: number | null
  delta_pct: number | null
}

export interface DueCard { key: DueKind; label: string; overdue: number; due7: number; due_window: number; listed: number }

export interface DueItem extends Pick<AssetBrief, 'id' | 'code' | 'name' | 'model' | 'make' | 'department' | 'department_id'> {
  kind: DueKind
  kind_label: string
  due: string
  days: number
  urgency: Urgency
  detail: string
  fail: boolean
  grace: number
}

export interface TicketRow {
  id: string
  code: string | null
  type?: string
  status: string | null
  severity: string | null
  reported_at: string | null
  age_hours: number | null
  days_overdue?: number
  problem: string | null
  assigned_to: string | null
  asset_id: string | null
  asset_code: string | null
  asset_name: string | null
  asset_model: string | null
  department: string | null
  takes_down: boolean
}

export interface MonthRow { month: string; label: string; registered: number; register_size: number; in_period: boolean }

export interface DueCompliance { tracked: number; compliant: number; overdue: number; failed: number; pct: number | null }

export interface Dashboard {
  generated_at: string
  today: string
  hospital: string
  branch: string | null
  period: { key: PeriodKey; label: string; from: string; to: string; as_of: string; fy: string }
  compare: { key: CompareKey; label: string; from: string; to: string } | null
  window: DueWindow
  can_finance: boolean
  kpis: {
    total: number
    active: number
    active_pct: number | null
    out_of_service: number
    out_for_service: number
    open_work_orders: number
    open_breakdowns: number
    pm_jobs_owed: number
    pm_overdue: number
    nbv: number | null
  }
  flows: Flow[]
  alerts: { due: number; maintenance: number; compliance: number; register: number; finance: number }
  overview: {
    under_maintenance: number
    open_breakdowns: number
    critical_down: number
    outside_hospital: number
    pending_approval: number
    under_warranty: number
  }
  due: { window: number; expired_listed_days: number; cards: DueCard[]; total: number; items: DueItem[]; overdue_total: number }
  charts: { status: CountRow[]; category: CountRow[]; department: CountRow[]; age: CountRow[]; registered_by_month: MonthRow[] }
  recent: (AssetBrief & { registered_on: string | null })[]
  open_breakdowns: TicketRow[]
  maintenance: {
    by_severity: { severity: string; count: number }[]
    work_orders: TicketRow[]
    work_orders_total: number
    period: Record<string, number | null>
    root_causes: CountRow[]
    upcoming_jobs: { id: string; code: string; type: string; due_date: string; asset_id: string; asset_code: string | null; asset_name: string | null; department: string | null }[]
  }
  compliance: {
    aerb: { valid: number; expiring: number; expired: number; missing: number; no_expiry: number }
    warranty: { under: number; expiring: number; expired: number; none: number }
    cover: CountRow[]
    cover_total: number
    covered_pct: number | null
    high_uncovered: number
    high_uncovered_list: AssetBrief[]
    insurance: CountRow[]
    calibration: DueCompliance
    electrical_safety: DueCompliance
    pm: DueCompliance
    risk_class: CountRow[]
    alerts: number
  }
  register: {
    total: number
    pending_transfer: number
    outside_hospital: number
    lost: number
    pending_disposal: number
    disposed: number
    in_transit: number
    where: CountRow[]
    source: CountRow[]
    ownership: CountRow[]
    manufacturers: CountRow[]
    transfers: { id: string; code: string; status: string; asset_id: string; asset_code: string | null; asset_name: string | null; from: string | null; to: string | null; requested_on: string | null; type: string | null }[]
  }
  finance: {
    as_of: string
    cost: number
    acc_dep: number
    nbv: number
    period_dep: number
    uncosted: number
    by_category: { category: string; count: number; cost: number; acc_dep: number; nbv: number; period_dep: number }[]
    by_method: { method: string; count: number; cost: number; nbv: number }[]
    disposals: (AssetBrief & { disposal_date: string; method: string | null; proceeds: number; nbv_at_disposal: number; gain_loss: number })[]
    disposal_proceeds: number
  } | null
}

export interface DrillRow extends AssetBrief {
  cost: number | null
  nbv: number | null
  warranty_until: string | null
  cover: string
  down_since: string | null
  next_due: { kind: string; due: string; days: number; urgency: Urgency } | null
}

export interface DrillResult { bucket: string; title: string; total: number; rows: DrillRow[]; nbv: number | null }

export interface DashParams {
  period: PeriodKey
  date_from?: string
  date_to?: string
  compare: CompareKey
  window: DueWindow
}

/** What the dashboard asks its host to open. */
export type OpenRecord = { fqn: 'assets.assets' | 'assets.breakdowns' | 'assets.pm_jobs' | 'assets.transfers'; id: string }
