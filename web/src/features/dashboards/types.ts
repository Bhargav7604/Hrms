export type Fmt = 'number' | 'money' | 'percent' | 'minutes' | 'days' | 'text'
export type Verdict = 'better' | 'worse' | 'same' | null

export interface Tile {
  key: string
  label: string
  value: number | null
  format: Fmt
  previous?: number | null
  delta_pct?: number | null
  good?: 'up' | 'down' | null
  verdict?: Verdict
  point?: boolean
  icon?: string
  tone?: string
  sub?: string
  link?: string | null
  spark?: number[]
}

export interface RangeInfo { preset: string; from: string; to: string; days: number; label: string }
export interface CompareInfo { mode: string; from: string; to: string; label: string }

export interface TrendPoint { date: string; value: number; compare: number | null; compare_date: string | null }
export interface Trend { metric: string; label: string; format: Fmt; points: TrendPoint[]; total: number; compare_total: number | null; link?: string | null }

export interface NamedValue { name: string; value: number; share?: number | null }
export interface TopList { rows: NamedValue[]; others: { value: number; count: number; share: number } | null; total: number; link?: string | null }

export interface Ward { ward: string; type?: string | null; beds: number; operational: number; blocked: number; occupied: number; pct: number; band: 'Full' | 'Busy' | 'Available' }

export interface TatItem {
  key: string; label: string; sub: string; median: number | null; p90: number | null; measured: number; total: number
  coverage: number | null; target: number | null; target_code: string; on_target: boolean | null; link?: string | null
}
export interface TatSnapshot {
  gauge: { label: string; pct: number | null; measured: number; total: number; within: number; target: number | null; target_code: string; on_target: boolean | null; link?: string | null } | null
  items: TatItem[]
  can_set_targets: boolean
}

export interface AttentionItem { key: string; label: string; sub: string; count: number; tone: 'amber' | 'blue' | 'red'; icon: string; link?: string | null }

export interface ChartSpec {
  type: 'bar' | 'line' | 'area' | 'donut'
  x: string
  y: { key: string; label: string; type: string }[]
  data: Record<string, unknown>[]
  stacked?: boolean
  horizontal?: boolean
  truncated?: boolean
}

export interface CommandResponse {
  range: RangeInfo
  compare: CompareInfo | null
  tab: string
  tabs: string[]
  finance: boolean
  as_of: string
  hospital: string
  branch: string
  alert_count: number
  headline?: Tile[]
  data: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface WidgetSpec {
  id: string
  type: 'kpi' | 'line' | 'area' | 'bar' | 'donut' | 'table' | 'list'
  title: string
  w: number
  h: number
  source: { kind: 'metric'; key: string } | {
    kind: 'report'; code: string; x?: string; y?: string[]; columns?: string[]; filters?: Record<string, string>; limit?: number
  }
}

export interface WidgetData {
  denied?: boolean
  error?: string
  tile?: Tile
  trend?: Trend
  chart?: Omit<ChartSpec, 'type'>
  table?: { columns: { key: string; label: string; type: string }[]; rows: Record<string, unknown>[]; total: number }
  link?: string | null
  summary?: { label: string; value: number; format: Fmt }[]
}

export interface DashboardCard {
  key: string; name: string; description: string; icon: string; new?: boolean; kind: 'builtin' | 'custom' | 'link'
  favourite?: boolean; owner?: string; mine?: boolean; status?: string; visible_to_roles?: string[]; shared_with_users?: string[]
}

export interface Catalogue {
  groups: { key: string; name: string; description: string; icon: string; dashboards: DashboardCard[] }[]
  custom: DashboardCard[]
  favourites: string[]
  recent: string[]
  total: number
}
