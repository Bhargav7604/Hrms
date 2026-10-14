import { createContext, useContext } from 'react'
import { api, ApiError } from '@/lib/api'

export const PORTAL_LOGOUT = 'vlack:portal-logout'
type Query = Record<string, string | number | boolean | null | undefined>

/** Patient-portal API (/api/portal/*) with the portal token; a 401 signs the patient out. */
export async function papi<T>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  try {
    return await api<T>(`/portal${path}`, { ...opts, portal: true })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) window.dispatchEvent(new Event(PORTAL_LOGOUT))
    throw e
  }
}

export const publicPost = <T,>(path: string, body: unknown) => api<T>(`/public${path}`, { method: 'POST', body })

export const SCOPES = {
  appointments: 'Appointments', reports: 'Lab & radiology reports', bills: 'Bills & payments', rx: 'Prescriptions',
  consent: 'E-consent', tele: 'Teleconsult',
} as const

export interface Profile {
  id: string; name: string; uhid: string; age?: number | null; gender?: string | null; self: boolean; relation: string
  scopes: string[]; can_sign: boolean; can_pay: boolean
}
export interface Me {
  patient: Record<string, string | number | null | undefined | string[]> & { id: string; code: string; title: string; first_name?: string; phone?: string }
  account: { code?: string; mobile?: string; email?: string | null; preferred_language?: string | null; notification_prefs?: string[] | null; last_login?: string; dpdp_consent_at?: string }
  profiles: Profile[]
  hospital: { name: string }
}
export interface Appt {
  id: string; code: string; date: string; slot: string; token_no?: number | null; status: string; type?: string | null; reason?: string | null
  doctor?: string | null; doctor_id?: string | null; department?: string | null; can_cancel: boolean; teleconsult?: string | null
}
export interface ReportRow { id: string; code: string; test: string; category: string; ordered_at?: string; verified_at?: string; critical: boolean; abnormal: number }
export interface Tele {
  id: string; code: string; scheduled_at: string; doctor?: string | null; mode?: string | null; consult_type?: string | null; status: string
  fee?: number | null; payment_status?: string | null; can_join: boolean; join_hint?: string | null; advice?: string | null; follow_up_date?: string | null
}
export interface Home {
  profile: Profile; hospital: string; upcoming?: Appt[]; reports?: ReportRow[]; dues?: { outstanding: number; open_bills: number }
  consents_pending?: number; teleconsults?: Tele[]
}

export interface PortalState { me: Me; pid: string; profile: Profile; setPid: (id: string) => void; logout: () => void }
export const PortalContext = createContext<PortalState | null>(null)
export function usePortal(): PortalState {
  const c = useContext(PortalContext)
  if (!c) throw new Error('usePortal outside the portal')
  return c
}
export const allowed = (p: Profile, scope: string) => p.scopes.includes('Full access') || p.scopes.includes(scope)
export const firstName = (n?: string | null) => (n ?? '').replace(/^(Mr|Mrs|Ms|Master|Baby|Dr)\.?\s+/i, '').split(' ')[0]
