import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import type { Rec } from '@/lib/types'

// ------------------------------------------------------------------ server shapes

export interface RegSettings {
  duplicate_keys: string[]
  allow_duplicate_override: boolean
  registration_fee_enabled: boolean
  registration_fee_amount: number
  consult_billing_prompt: boolean
  family_tree_enabled: boolean
  edit_requires_document: boolean
  autofocus_field: string
  default_country: string
  default_state: string
  default_category: string
  patient_tags: string[]
  occupations: string[]
}

export interface RegConfig {
  settings: RegSettings
  duplicate_keys: { key: string; label: string }[]
  options: Record<'titles' | 'genders' | 'categories' | 'blood_groups' | 'marital_status' | 'religions' | 'relations' | 'emergency_relations'
    | 'referral_categories' | 'payer_types' | 'tags' | 'occupations' | 'states' | 'visit_types' | 'priorities', string[]>
}

export interface FieldRule {
  visible: boolean; hidden: boolean; required: boolean; readonly: boolean; editable: boolean; label: string
  default?: unknown; mask: boolean; order: number; section: string
}

export interface ScreenConfig {
  screen: string
  fields: Record<string, FieldRule>
  sections: { key: string; label: string; description?: string; icon?: string; fields: string[] }[]
  settings: Record<string, unknown>
}

export interface Dup {
  id: string; code: string; title: string; phone?: string; dob?: string; age?: number | null; gender?: string
  registered_at?: string; status?: string; keys: string[]; reasons: string[]
}

export interface PincodeInfo { pincode: string; areas: string[]; city?: string | null; district?: string | null; state?: string | null; country?: string; source: string; precision: string }

export interface AadhaarData {
  name?: string; first_name?: string; middle_name?: string; last_name?: string; dob?: string; yob?: number; age?: { years: number }
  gender?: string; guardian_relation?: string; guardian_name?: string; address?: string | null; area?: string | null; city?: string | null
  district?: string | null; state?: string | null; pincode?: string | null; format: string; aadhaar_last4?: string; aadhaar?: string
  aadhaar_valid?: boolean; mobile_last4?: string | null; signature_verified: boolean
}

export interface ConsultingDoctor {
  id: string; name: string; code?: string; specialization?: string; department_id?: string; department?: string; room?: string
  sessions: string[]; consult_fee?: number | null; on_leave?: Rec | null
}

export interface RegisterResult {
  patient: Rec
  age?: { years: number; months: number; days: number } | null
  visit?: {
    appointment: Rec; doctor: { id: string; name: string; department?: string }; token?: { label: string; queue: string; priority?: string } | null
    encounter_id?: string; charge?: { id: string; amount: number; description: string; status: string } | null; overbooked: boolean
  } | null
  fee?: { charge: Rec; invoice?: Rec | null } | null
  family?: Rec | null
  bill_prompt?: { charge_ids: string[]; amount: number; description: string; doctor: string } | null
  duplicates_overridden: string[]
}

export interface DraftRow {
  id: string; code: string; name: string; phone?: string; gender?: string; visit_doctor?: string; notes?: string; saved_at?: string
  status: string; saved_by_name?: string; doctor_name?: string; mine: boolean
}

// ------------------------------------------------------------------ queries

export function useRegConfig() {
  return useQuery({ queryKey: ['x', 'registration', 'config'], queryFn: () => api<RegConfig>('/registration/config'), staleTime: 5 * 60_000 })
}

/** Effective Field Configuration of a screen; null when the platform has none (screens fall back to their defaults). */
export function useScreenConfig(screen: string) {
  return useQuery({
    queryKey: ['x', 'settings', 'screen', screen],
    queryFn: async () => {
      try {
        return await api<ScreenConfig>(`/fieldconfig/screens/${screen}`)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
  })
}

// ------------------------------------------------------------------ identity helpers

const D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
const P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]

export const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '')

/** Aadhaar: 12 digits, not starting 0/1, Verhoeff checksum. */
export function aadhaarValid(num: string): boolean {
  if (!/^[2-9]\d{11}$/.test(num)) return false
  let c = 0
  num.split('').reverse().forEach((ch, i) => { c = D[c][P[i % 8][Number(ch)]] })
  return c === 0
}

export const groupAadhaar = (s: string) => digits(s).slice(0, 12).replace(/(\d{4})(?=\d)/g, '$1 ')
export const groupAbha = (s: string) => {
  const d = digits(s).slice(0, 14)
  return [d.slice(0, 2), d.slice(2, 6), d.slice(6, 10), d.slice(10, 14)].filter(Boolean).join('-')
}

export const MOBILE_RE = /^[6-9]\d{9}$/
export const PAN_RE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/
export const PASSPORT_RE = /^[A-Z]\d{7}$/
export const VOTER_RE = /^[A-Z]{3}\d{7}$/

export interface Ymd { years?: number | ''; months?: number | ''; days?: number | '' }

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Exact age in years / months / days on `ref` (today). */
export function ageFromDob(dob: string, ref = new Date()): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob)
  if (!m) return null
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (b > ref) return null
  let y = ref.getFullYear() - b.getFullYear()
  let mo = ref.getMonth() - b.getMonth()
  let d = ref.getDate() - b.getDate()
  if (d < 0) {
    mo -= 1
    d += new Date(ref.getFullYear(), ref.getMonth(), 0).getDate()
  }
  if (mo < 0) {
    y -= 1
    mo += 12
  }
  return { years: y, months: mo, days: d }
}

/** DOB estimated from an age (same arithmetic as the server). */
export function dobFromAge(a: Ymd, ref = new Date()): string | null {
  const y = Number(a.years || 0)
  const mo = Number(a.months || 0)
  const d = Number(a.days || 0)
  if (!y && !mo && !d) return null
  const t = new Date(ref.getFullYear() - y, ref.getMonth() - mo, 1)
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()
  t.setDate(Math.min(ref.getDate(), last))
  t.setDate(t.getDate() - d)
  return iso(t)
}

export const fullName = (p: Rec) => [p.salutation, p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ')
