import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Rec } from '@/lib/types'

/** Query keys start with ['x', 'er', …] so realtime change events on ER records refresh them. */
export const erKey = (...parts: unknown[]) => ['x', 'er', ...parts]

export type ErState = 'Active' | 'Awaiting billing' | 'Closed'
export type ClockState = 'ok' | 'near' | 'breached' | 'met' | 'missed' | 'none'

export interface TriageBrief {
  key: string
  value: string
  label: string
  priority?: string | null
  color?: string | null
  target_minutes?: number | null
}

export interface VisitSummary {
  id: string
  code: string
  status: string
  state: ErState
  arrived_at?: string | null
  minutes_in_er?: number | null
  los_state: 'ok' | 'near' | 'breached' | 'done'
  los_target_minutes: number
  patient: { id: string; name: string; uhid?: string | null; age?: number | null; gender?: string | null; phone?: string | null; temporary: boolean }
  bed: { id: string; bed_no?: string | null; ward_id?: string | null; ward?: string | null } | null
  doctor: { id: string; name?: string | null } | null
  triage: TriageBrief | null
  triaged_at?: string | null
  triage_clock: { state: ClockState; wait_minutes?: number; target_minutes?: number | null; due_at?: string }
  chief_complaint?: string | null
  arrival_mode?: string | null
  payer?: string | null
  mlc: boolean
  mlc_no?: string | null
  disposition?: string | null
  outcome?: string | null
  provisional_diagnosis?: string | null
  current_step: { key: string | null; label: string }
  progress: { done: number; total: number }
  bill: { id: string; code: string; status: string; net?: number; balance?: number } | null
  flags: string[]
  alerts: string[]
  unbilled?: number
  last_handover?: Rec | null
}

/** Role permissions for the ER suite (server-computed — the matrix level and the clinical role). */
export interface RolePerms {
  read: boolean; board: boolean; tracking: boolean; register: boolean; view_clinical: boolean; view_billing: boolean
  triage: boolean; nursing: boolean; doctor: boolean; assign: boolean; orders: boolean; treatment: boolean; vitals: boolean
  status: boolean; dispose: boolean; abscond: boolean; mlc: boolean; alerts: boolean; handover: boolean; move_bed: boolean
  details: boolean; link: boolean; documents: boolean; bill: boolean; close: boolean; override_close: boolean; settings: boolean
}

/** Per-visit permissions: role permissions narrowed by the visit's state. */
export type VisitPerms = Pick<RolePerms, 'triage' | 'nursing' | 'doctor' | 'assign' | 'orders' | 'treatment' | 'vitals' | 'status' | 'dispose'
  | 'abscond' | 'move_bed' | 'handover' | 'alerts' | 'view_clinical' | 'mlc' | 'details' | 'link' | 'documents' | 'view_billing' | 'bill'
  | 'close' | 'override_close' | 'board' | 'tracking' | 'register'> & { print_mlc: boolean }

export interface Step { key: string; label: string; done_at?: string | null; optional: boolean; current: boolean }
export interface Steps { steps: Step[]; done: number; total: number; current: string | null; current_label: string }

export interface Assignment { doctor_id?: string | null; doctor?: string | null; at?: string | null; by?: string | null; reason?: string | null }
export interface VisitDoc { file_id: string; name: string; mime?: string; size?: number; category: string; note?: string | null; uploaded_at: string; uploaded_by?: string }
export interface Allergy { id: string | null; allergen: string; type?: string | null; severity?: string | null; reaction?: string | null }
export interface VitalPoint {
  id?: string; recorded_at?: string; temperature?: number; pulse?: number; resp_rate?: number; bp_systolic?: number; bp_diastolic?: number
  spo2?: number; o2_support?: string; pain_score?: number; gcs?: number; blood_sugar?: number; bmi?: number; news2?: number; news2_risk?: string
}

export interface VisitDetail {
  visit: Rec
  summary: VisitSummary
  steps: Steps
  patient: Rec
  temporary: boolean
  triage_history: Rec[]
  nursing: Rec | null
  doctor_assessment: Rec | null
  treatments: Rec[]
  handovers: Rec[]
  allergies: Allergy[]
  allergy_status: 'recorded' | 'nka' | 'not_recorded'
  latest_vitals: VitalPoint | null
  mlc_case: Rec | null
  admission: Rec | null
  assignments: Assignment[]
  documents: VisitDoc[]
  permissions: VisitPerms
  refs: Record<string, string>
}

export interface TriageLevel extends TriageBrief { enabled?: boolean }

export interface ErSettings {
  flow: {
    optional_steps: string[]; auto_assign_doctor: boolean; doctor_departments: string[]; los_target_minutes: number
    carry_charges_to_admission: boolean; auto_close_on_admission: boolean; observation_charge_code: string
    observation_block_hours: number; specialist_visit_charge_code: string
  }
  triage: { system: string; levels: TriageLevel[] }
  board: { refresh_seconds: number; actions: string[]; columns: string[] }
  registration: { default_arrival_mode: string; default_payer: string; mlc_arrival_modes: string[]; require_bed: boolean }
  disposition: { types: Record<string, { enabled: boolean; required: string[] }> }
  documents: { categories: string[] }
  alerts: string[]
  handover: { shifts: { key: string; start: string }[] }
}

/** Effective ER settings (the `er` namespace of the settings store merged over the engine defaults). */
export function useErSettings() {
  return useQuery({ queryKey: erKey('settings'), queryFn: () => api<ErSettings>('/er/settings/effective'), staleTime: 5 * 60_000 })
}

export function useVisit(id: string | undefined) {
  return useQuery({
    queryKey: erKey('visit', id),
    queryFn: () => api<VisitDetail>(`/er/visits/${id}`),
    enabled: !!id,
    placeholderData: (prev) => prev,
  })
}

/** Refresh every ER view after a mutation (chart, boards, billing). */
export function useErRefresh() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['x', 'er'] })
}

/** A clock that re-renders every `ms` so time-in-ER counters stay live. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

export function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60_000))
}

/** 8h 01m · 10m · 1d 4h */
export function hm(mins: number | null | undefined): string {
  if (mins === null || mins === undefined) return '—'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = Math.floor(mins % 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

/** Live minutes in ER for active visits; the stored length of stay otherwise. */
export function liveMinutes(v: Pick<VisitSummary, 'state' | 'arrived_at' | 'minutes_in_er'>, now: number) {
  return v.state === 'Active' ? minutesSince(v.arrived_at, now) : v.minutes_in_er ?? null
}

export function losState(mins: number | null, target: number, state: ErState): 'ok' | 'near' | 'breached' | 'done' {
  if (state !== 'Active' || mins === null) return 'done'
  return mins >= target ? 'breached' : mins >= target * 0.75 ? 'near' : 'ok'
}

/** Live time-to-doctor state against the triage target. */
export function clockState(v: VisitSummary, now: number): ClockState {
  const c = v.triage_clock
  if (c.state !== 'ok' && c.state !== 'near' && c.state !== 'breached') return c.state
  const target = c.target_minutes
  const wait = minutesSince(v.arrived_at, now)
  if (target === null || target === undefined || wait === null) return c.state
  return wait > target ? 'breached' : wait >= target * 0.75 ? 'near' : 'ok'
}

export const STEP_PANEL: Record<string, string> = {
  registration: 'registration', triage: 'triage', nursing_assessment: 'nursing-assessment', doctor_assignment: 'doctor-assignment',
  doctor_assessment: 'doctor-assessment', orders: 'investigations', treatment: 'treatment', disposition: 'disposition', billing: 'billing',
}

/** Deep link into the ER chart: workflow steps use ?step=, other panels ?panel=. */
export function chartLink(id: string, panel?: string, extra?: Record<string, string>) {
  const steps = new Set(['triage', 'nursing-assessment', 'doctor-assignment', 'doctor-assessment', 'treatment', 'disposition', 'billing'])
  const q = new URLSearchParams(extra)
  if (panel && panel !== 'overview') q.set(steps.has(panel) ? 'step' : 'panel', panel)
  const s = q.toString()
  return `/er/visits/${id}${s ? `?${s}` : ''}`
}

export const OUTCOME_LABEL: Record<string, string> = {
  Discharged: 'Discharged home', Admitted: 'Admitted to ward', Transferred: 'Transferred out', Referred: 'Referred',
  LAMA: 'Left against medical advice', DAMA: 'Discharged against medical advice', 'Expired': 'Expired in ER',
  'Brought dead': 'Brought dead', Absconded: 'Absconded', 'Shifted to OT': 'Shifted to OT',
}
