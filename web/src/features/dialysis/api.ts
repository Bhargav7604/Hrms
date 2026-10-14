import { useAuth, useRegistry } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import type { BadgeTone } from '@/components/ui'

/** Dialysis desk: billed patient → check-in → session record → check-out (backend: engines/dialysisdesk.py). */

export interface DPatient { id: string; uhid?: string; name?: string; age?: number | null; gender?: string | null; phone?: string | null }

export interface Entitlement {
  charge_id: string; charge_code?: string; patient_id: string; service?: string | null; service_code?: string | null; bill_id: string; bill: string
  billed_at?: string | null; sessions: number; used: number; available: number; used_by: { id: string; code: string; status: string }[]
}

export interface IpInfo { encounter_id: string; ip_no: string; admitted_at?: string | null; bed?: string | null; ward?: string | null }

export interface OpenBrief { id: string; code: string; status: string; machine?: string | null; checked_in_at?: string | null; started_at?: string | null }

export interface DeskRow extends DPatient {
  bills: Entitlement[]; available_sessions: number; ip: IpInfo | null; open_session: OpenBrief | null; eligible: boolean; last_billed_at?: string | null
}

export interface DeskList { rows: DeskRow[]; total: number; showing: number }

export interface Machine {
  id: string; code?: string; name: string; station?: string | null; make?: string | null; model?: string | null; segregation?: string | null
  status: string; last_disinfection?: string | null; hdf_capable?: boolean | null; compatible?: boolean; warning?: string | null
}

export interface ChartRow {
  time: string; bp?: string; pulse?: number; qb?: number; venous_pressure?: number; tmp?: number; uf_volume?: number; remarks?: string
}

export interface Session {
  id: string; code: string; status: string; modality?: string | null; scheduled_at?: string | null; checked_in_at?: string | null
  started_at?: string | null; ended_at?: string | null; machine?: string | null; machine_name?: string | null; machine_warning?: string | null
  pre_weight?: number | null; post_weight?: number | null; pre_bp?: string | null; post_bp?: string | null; pre_pulse?: number | null
  post_pulse?: number | null; pre_temperature?: number | null; uf_goal_ml?: number | null; uf_achieved_ml?: number | null
  blood_flow_rate?: number | null; heparin_units?: number | null; dialyser_use_no?: number | null; access_used?: string | null
  hourly_chart?: ChartRow[] | null; intradialytic_events?: string[] | null; complications?: string | null; drugs_given?: string | null
  ktv?: number | null; duration_minutes?: number | null; billing_ref?: string | null; notes?: string | null; plan?: string | null
}

export interface Plan {
  id: string; code: string; status: string; modality?: string | null; frequency?: string | null; shift?: string | null; indication?: string | null
  viral_status?: string | null; dry_weight_kg?: number | null; vascular_access?: string | null; blood_flow_rate?: number | null
  duration_hours?: number | null; target_ktv?: number | null; dialyser?: string | null; anticoagulation?: string | null; payer?: string | null
}

export interface VascularAccess { id: string; code: string; access_type: string; site?: string | null; status?: string | null; thrill_bruit?: string | null; complication?: string | null }

export interface DeskRecord {
  patient: DPatient; plan: Plan | null; access: VascularAccess[]; entitlements: Entitlement[]; available_sessions: number; ip: IpInfo | null
  open_session: Session | null; sessions: Session[]; machines: Machine[]; can_operate: boolean
}

export interface TodaySession {
  id: string; code: string; status: string; modality?: string | null; checked_in_at?: string | null; started_at?: string | null
  ended_at?: string | null; billing_ref?: string | null; patient: DPatient | null; machine?: string | null
}

export interface TodayBoard { sessions: TodaySession[]; by_status: Record<string, number>; machines: Machine[]; window: [string, string] }

/** Query keys start with ['x', 'dialysis'] so session / machine changes refresh the desk through realtime. */
export const DK = {
  all: ['x', 'dialysis'] as const,
  patients: (q: string) => ['x', 'dialysis', 'desk-patients', q] as const,
  record: (pid: string) => ['x', 'dialysis', 'desk-record', pid] as const,
  today: ['x', 'dialysis', 'desk-today'] as const,
}

export const MODALITIES = ['HD', 'HDF', 'SLED', 'Isolated UF']
export const ACCESS_TYPES = ['AV fistula', 'AV graft', 'Tunnelled cuffed catheter (permcath)', 'Non-tunnelled IJV catheter',
  'Non-tunnelled femoral catheter', 'PD catheter']
export const EVENTS = ['None', 'Hypotension', 'Cramps', 'Nausea / vomiting', 'Headache', 'Chest pain', 'Fever / rigors', 'Access bleed',
  'Circuit clotting', 'Arrhythmia', 'Hypoglycaemia']
export const BP_RE = /^\d{2,3}\/\d{2,3}$/
export const OPEN_STATUSES = ['Scheduled', 'Checked In', 'In Progress']

export const SESSION_TONE: Record<string, BadgeTone> = {
  Scheduled: 'gray', 'Checked In': 'amber', 'In Progress': 'blue', Completed: 'green', Missed: 'red', Cancelled: 'red',
}
export const MACHINE_TONE: Record<string, BadgeTone> = {
  Available: 'green', 'In Use': 'blue', Disinfection: 'amber', Maintenance: 'violet', Retired: 'gray',
}
export function viralTone(v?: string | null): BadgeTone {
  if (!v) return 'gray'
  if (/reactive/i.test(v) && !/non/i.test(v)) return 'red'
  if (/awaiting/i.test(v)) return 'amber'
  return 'green'
}

/**
 * Who may use the desk — mirrors the server: GETs for nurse, doctor, management, billing; actions for nurse and doctor
 * (admin passes every check). Billing and management therefore see the desk read-only.
 */
export function useDeskAccess() {
  const { user } = useAuth()
  const reg = useRegistry()
  const me = user ?? reg.meta?.user ?? null
  const role = me?.role ?? ''
  const admin = role === 'admin'
  return {
    ready: !!reg.meta && !!me,
    role,
    page: reg.canPage('dialysis', 'dialysis-desk'),
    view: admin || ['nurse', 'doctor', 'management', 'billing'].includes(role),
    operate: reg.canPage('dialysis', 'dialysis-desk', 'edit') && (admin || ['nurse', 'doctor'].includes(role)),
  }
}

export type DeskAccess = ReturnType<typeof useDeskAccess>

/** Server field errors ("pre_bp", or pydantic "body.pre_bp" flattened to "pre_bp"). */
export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError ? e.fieldErrors : {}
}

/** '' → undefined, otherwise a number (NaN when not numeric). */
export function numOrUndef(s: string): number | undefined {
  const t = s.trim()
  return t ? Number(t) : undefined
}

export const kg = (n?: number | null) => (n === null || n === undefined ? '—' : `${n} kg`)
