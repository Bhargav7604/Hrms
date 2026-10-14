/** Shapes returned by the queue engine (backend/app/engines/queue.py). */

export const PRIORITIES = ['Normal', 'Senior Citizen', 'Differently Abled', 'Emergency'] as const
export type Priority = (typeof PRIORITIES)[number]
export const TOKEN_STATUSES = ['Waiting', 'Called', 'Serving', 'Done', 'Skipped'] as const
export const TOKEN_SOURCES = ['Walk-in', 'Kiosk', 'Appointment', 'Registration', 'Transfer'] as const

export interface PatientLabel { name: string; uhid: string; age?: number | null; gender?: string | null }

export interface QToken {
  id: string; code: string; queue: string; token_no: number; label: string; status: string; priority?: string | null
  called_at?: string | null; served_at?: string | null; counter?: string | null; counter_name?: string | null
  call_count?: number | null; appointment?: string | null; source?: string | null; created_at?: string; wait_min?: number | null
  patient_id?: string | null; patient?: PatientLabel | null
}

export interface IssueResult { token: QToken; ahead: number; queue_name: string; hospital: string }
export interface TransferResult { token: QToken; from: string; queue_name: string }

// ------------------------------------------------------------------ monitor / kiosk

export interface MonitorLine {
  queue: string; code: string; name: string; kind: string
  department_id?: string | null; department?: string | null; owner?: string | null; room?: string | null
  waiting: number; called: number; in_service: number; held: number; served: number; issued: number
  longest_wait_min: number | null; est_wait_min: number; avg_wait_min: number | null; avg_service_min: number | null
  last_issued: { label: string; at: string } | null
  last_called: { label: string; at: string; counter?: string | null } | null
  counters: number; open_counters: number; capacity: number | null; at_capacity: boolean
  master_id?: string | null; kiosk: boolean; display_order: number
}

export interface Monitor {
  lines: MonitorLine[]
  kinds: string[]
  departments: { id: string; name: string }[]
  kpis: { waiting: number; called: number; in_service: number; held: number; longest_wait_min: number | null; at_capacity: number; issued: number }
  updated_at: string
}

export type KioskLine = Pick<MonitorLine, 'queue' | 'name' | 'kind' | 'department_id' | 'department' | 'owner' | 'room' | 'waiting'
  | 'est_wait_min' | 'capacity' | 'at_capacity' | 'issued'>

export interface Kiosk { lines: KioskLine[]; hospital: string }

// ------------------------------------------------------------------ display boards (public — no patient data)

export interface BoardLine {
  queue: string; name: string; room?: string | null; kind: 'counter' | 'doctor'
  serving: { label: string; status: string; called_at?: string | null; counter?: string | null }[]
  next: string[]; waiting: number; avg_wait_min?: number | null
  /** department screen only */
  doctor?: string | null; sessions?: string[] | null
}

export interface DisplayState {
  hospital: string; time: string; queues: BoardLine[]
  last_called: { queue: string; label: string; counter?: string | null; at?: string | null } | null
}

export interface PublicBoard extends DisplayState {
  board: { code: string; name: string; location?: string | null; ticker?: string | null; announce?: boolean }
}

export interface PublicDepartment extends DisplayState {
  department: { id: string; code?: string | null; name: string }
}

export interface BoardConfig {
  id: string; code: string; name: string; location?: string | null; department?: string | null; department_name?: string | null
  queues?: string[] | null; next_count?: number | null; announce?: boolean | null; ticker?: string | null; status: string
}

// ------------------------------------------------------------------ register / reports

export interface RegisterRow {
  id: string; code: string; date: string; label: string; queue: string; queue_name: string; status: string
  priority?: string | null; source?: string | null; patient_id?: string | null; patient?: string | null; uhid?: string | null
  issued_at?: string | null; called_at?: string | null; served_at?: string | null; counter?: string | null; calls?: number | null
  transferred_to?: string | null; wait_min?: number | null; service_min?: number | null
}

export interface RegisterPage { rows: RegisterRow[]; total: number; page: number; limit: number }

export interface Reports {
  from: string; to: string
  by_day: { date: string; issued: number; served: number; skipped: number; avg_wait_min: number | null }[]
  by_hour: { hour: number; label: string; issued: number; avg_wait_min: number | null; avg_service_min: number | null }[]
  by_queue: { queue: string; name: string; issued: number; served: number; skipped: number; avg_wait_min: number | null
    p90_wait_min: number | null; max_wait_min: number | null; avg_service_min: number | null }[]
  by_source: { source: string; issued: number }[]
  by_priority: { priority: string; issued: number; avg_wait_min: number | null }[]
  totals: { issued: number; served: number; skipped: number; avg_wait_min: number | null; p90_wait_min: number | null; avg_service_min: number | null }
}
