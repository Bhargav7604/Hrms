export interface ReportCard {
  code: string; name: string; category: string; description: string; filters: string[]; popular: boolean; tags: string[]; icon: string
  kind: 'curated' | 'register' | 'statutory'; chart: boolean; finance: boolean
}
export interface Category { name: string; description: string; icon: string; order: number; count: number }
export interface HubCatalog {
  total: number; categories: Category[]; reports: ReportCard[]; favourites: string[]; recent: string[]; popular: string[]
  periods: { key: string; label: string }[]
}
export interface ColDef { key: string; label: string; type: string; default: boolean; total: boolean }
export interface FilterDef { key: string; label: string; type: 'period' | 'text' | 'select' | 'ref'; options?: string[]; ref?: string; ref_filter?: Record<string, unknown>; placeholder?: string }
export interface SavedView { id: string; code: string; name: string; state: ViewState; shared: boolean; mine: boolean; owner?: string }
export interface ViewState { filters?: Record<string, string>; columns?: string[]; sort?: string; density?: 'comfortable' | 'compact'; view?: 'table' | 'chart' }
export interface Schedule {
  id: string; code: string; name: string; report_code: string; schedule: string; schedule_time: string; weekday?: string | null; month_day?: number | null
  period?: string; recipients?: string[]; recipient_roles?: string[]; format: string; next_run_at?: string; last_run_at?: string; last_status?: string
  status: string; owner_name?: string; mine: boolean
}
export interface ReportMeta {
  code: string; name: string; category: string; description: string; icon: string; kind: string; popular: boolean
  filters: FilterDef[]; columns: ColDef[]; chart: Record<string, unknown> | null; default_period: string; default_sort?: string | null
  favourite: boolean; views: SavedView[]; schedules: Schedule[]; periods: { key: string; label: string }[]; hospital: string
}
export interface RunResult {
  rows: Record<string, unknown>[]; total: number; page: number; limit: number; totals: Record<string, number>
  summary: { label: string; value: number | null; format: string }[]; note?: string | null
  chart: { type: 'bar' | 'line' | 'area' | 'donut'; x: string; y: { key: string; label: string; type: string }[]; data: Record<string, unknown>[]; stacked?: boolean; horizontal?: boolean; truncated?: boolean } | null
  period: { key: string; from: string | null; to: string | null; label: string }; generated_at: string
}
