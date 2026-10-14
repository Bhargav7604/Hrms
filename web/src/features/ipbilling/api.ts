import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError, apiUrl, errorMessage } from '@/lib/api'

/** Query keys start with ['x', 'billing'] so realtime billing changes refresh every IP-billing view. */
export const K = {
  all: ['x', 'billing', 'ipb'] as const,
  list: (p: Record<string, unknown>) => ['x', 'billing', 'ipb', 'list', p] as const,
  bill: (id: string) => ['x', 'billing', 'ipb', 'bill', id] as const,
  discharge: (id: string) => ['x', 'billing', 'ipb', 'discharge', id] as const,
  queue: (q: string) => ['x', 'billing', 'ipb', 'queue', q] as const,
  discharged: (p: Record<string, unknown>) => ['x', 'billing', 'ipb', 'discharged', p] as const,
  docs: (id: string) => ['x', 'billing', 'ipb', 'docs', id] as const,
  desk: (p: Record<string, unknown>) => ['x', 'billing', 'ipb', 'desk', p] as const,
}

export interface RolePerms {
  write: boolean; collect: boolean; refund: boolean; approx: boolean; notify: boolean; discharge: boolean; reopen: boolean
  documents: boolean; estimate: boolean; preauth: boolean; approve: boolean; line_discount_limit: number | null
}
export interface BillPerms extends RolePerms {
  edit: boolean; price: boolean; discount_limit: number; initiate: boolean; settle: boolean; finalise: boolean; closed: boolean
}

export interface PatientInfo {
  id: string; uhid: string | null; name: string; gender: string | null; age: number | null; phone: string | null
  blood_group: string | null; category: string | null; payer_type: string | null; photo: string | null; allergies?: string[]
}
export interface Sponsor {
  sponsor_id: string | null; sponsor_name: string | null; payer_type: string; approved_amount: number | null
  approved_source: string | null; co_pay_percent: number; credit_ref: string | null; sponsored: boolean
}
export interface Position {
  net: number; patient_payable: number; sponsor_payable: number; paid: number; advance: number; balance: number
  status: string; bill_id: string | null; bill_code: string | null; working_bill_id: string | null; working_bill_code: string | null
  payment_status: string; paid_on_bills: number; sponsor_received: number; billed_net: number; unbilled_net: number
  unbilled_count: number; gross: number; discount: number; gst: number; bill_discount_pending: number; sponsor: Sponsor
  percent_paid: number
}
export interface Line {
  id: string; code: string; date: string; service_id: string | null; service_code: string | null; name: string
  group: string; head: string; category: string; ward_type: string | null; qty: number; rate: number; base_rate: number | null
  gross: number; disc_mode: '₹' | '%'; disc_value: number; discount: number; tax_percent: number; gst: number
  after_total: number; covered: boolean; covered_by: string | null; kind: 'service' | 'package'; package_id: string | null
  status: string; invoice_id: string | null; invoice_code: string | null; source: string | null; source_label: string
  price_source: string; price_overridden: boolean; locked: boolean; lock_reason: string | null; tab: string | null
  unpriced: boolean; doctor: string | null
}
export interface PackageView {
  line_id: string; package_id: string | null; name: string; price: number; los_days: number | null; room_category: string | null
  status: string; covered_count: number; covered_value: number
  services: { service_id: string | null; name: string | null; qty: number; used: number }[]
}
export interface Totals {
  gross: number; line_discount: number; bill_discount: number; bill_discount_pending: number; gst: number; taxable: number
  net: number; covered_count: number; covered_value: number; on_top_count: number; on_top_amount: number; packages: number; services: number
}
export interface Receipt {
  id: string; code: string; kind: string; mode: string; amount: number; reference: string | null; remarks?: string | null
  paid_at: string; status: string; invoice_id: string | null; received_by?: string | null
}
export interface AdmissionInfo {
  id: string; ip_no: string; status: string; admitted_at: string; discharged_at: string | null; diagnosis: string | null
  discharge_type: string | null; discharge_initiated_at: string | null; los_days: number; doctor: string | null
  department: string | null; bed: { id: string; bed_no: string; category: string | null; rate: number | null } | null
  ward: { id: string; name: string; floor: string | null; type: string | null } | null; payer: string | null
}
export interface Bill {
  admission: AdmissionInfo
  patient: PatientInfo
  state: Record<string, unknown> & { id: string; code: string; status: string } | null
  sponsor: Sponsor & { payer_kind: string | null; tariff: { id: string | null; code: string; name: string; basis: string; percent: number } | null; price_sponsor_name: string | null }
  ward_category: string | null
  lines: Line[]
  packages: PackageView[]
  totals: Totals
  position: Position
  invoices: { id: string; code: string; type: string; payer: string; gross: number; discount: number; tax: number; net: number; paid: number; balance: number; status: string; billed_at: string }[]
  receipts: Receipt[]
  stats: { los_days: number; since: string; packages: number; services: number; payment_status: string }
  approx_bills: { no: string; at: string; by: string; net: number; patient_payable: number; balance: number }[]
  ward_changes: { from_date: string; category: string; room_rate?: number; source: string; by?: string; at?: string; reason?: string; lines?: number; delta?: number }[]
  sponsor_history: { at: string; by: string; mode: string; sponsor: string; tariff: string; lines: number; reason?: string }[]
  bill_discount: { mode: '%' | '₹'; value: number; reason: string | null; status: string; approval: { id: string; code: string; status: string; approver_role: string; comments?: string } | null }
  permissions: BillPerms
  policy: { discount_approval_percent: number }
}
export interface ReadinessItem { key: string; label: string; done: boolean; applicable: boolean; roles: string[] }
export interface DischargeData extends Bill {
  readiness: {
    ready: boolean; pending: string[]; items: ReadinessItem[]; checklist: { id: string; code: string; status: string } | null
    summary: { id: string; code: string; status: string } | null; tat_minutes: number | null; target_minutes: number
  } | null
  clinical_pending: string[]
  notifications: { at: string; by: string; step: string; roles: string[]; message: string }[]
  discharge_types: DischargeType[]
  notify_roles: Record<string, string[]>
  draft: { discharge_type: DischargeType; remarks: string | null }
}
export type DischargeType = 'Normal' | 'DAMA' | 'LAMA' | 'Transfer' | 'Absconded' | 'Death'

export interface Row {
  id: string; ip_no: string; status: string; admitted_at: string; discharged_at: string | null; discharge_type: string | null
  patient: PatientInfo; bed: AdmissionInfo['bed']; ward: AdmissionInfo['ward']; doctor: string | null; department: string | null
  sponsor: string; payer_type: string; los_days: number; net: number; balance: number; paid: number; patient_payable: number
  bill_status: string; payment_status: string; bill_id: string | null; initiated_at?: string | null
}
export interface ListResult { rows: Row[]; total: number; page: number; limit: number; counts?: Record<string, number>; permissions: RolePerms }

export interface DocType { key: string; label: string; category?: string; formats: string[]; max_mb: number }
export interface IpbSettings {
  document_types: DocType[]
  print: { default_format?: string; letterhead?: boolean; footer?: string }
  letterhead: { name?: string; address?: string; gstin?: string; phone?: string; email?: string; tagline?: string }
  notify_roles: Record<string, string[]>
}

// ------------------------------------------------------------------ hooks

export function useBill(id: string | undefined) {
  return useQuery({ queryKey: K.bill(id ?? ''), queryFn: () => api<Bill>(`/ipbilling/admissions/${id}/bill`), enabled: !!id })
}

/** Mutations that return the refreshed bill write it straight into the cache (autosave feel). */
export function useBillMutation<V>(id: string, fn: (v: V) => Promise<unknown>, opts: { success?: string | ((r: unknown) => string | undefined); onDone?: (r: unknown) => void } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      const bill = (r as { bill?: Bill })?.bill ?? ((r as Bill)?.lines ? (r as Bill) : undefined)
      if (bill) qc.setQueryData(K.bill(id), bill)
      qc.invalidateQueries({ queryKey: K.all, predicate: (q) => q.queryKey[3] !== 'bill' || q.queryKey[4] !== id || !bill })
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success
      if (msg) toast.success(msg)
      opts.onDone?.(r)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

const SETTINGS_FALLBACK: IpbSettings = {
  document_types: ['ID Proof', 'Insurance', 'Referral', 'Consent', 'Discharge Summary'].map((label) => ({
    key: label.toLowerCase().replace(/\s+/g, '_'), label, formats: ['JPG', 'JPEG', 'PNG', 'PDF'], max_mb: 10,
  })),
  print: { default_format: 'summarised', letterhead: true }, letterhead: {}, notify_roles: {},
}

function normaliseSettings(raw: unknown, base: IpbSettings): IpbSettings {
  const r = (raw && typeof raw === 'object' ? ((raw as { value?: unknown }).value ?? raw) : {}) as Partial<IpbSettings>
  return {
    document_types: Array.isArray(r.document_types) && r.document_types.length ? r.document_types : base.document_types,
    print: { ...base.print, ...(r.print ?? {}) },
    letterhead: { ...base.letterhead, ...(r.letterhead ?? {}) },
    notify_roles: { ...base.notify_roles, ...(r.notify_roles ?? {}) },
  }
}

/** Admin-configured IP billing settings (W1 store: /settings/ipbilling); defaults when not configured. */
export function useIpbSettings() {
  return useQuery({
    queryKey: ['x', 'billing', 'ipb', 'settings'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const defaults = await api<IpbSettings>('/ipbilling/settings').catch(() => SETTINGS_FALLBACK)
      try {
        return normaliseSettings(await api('/settings/ipbilling'), defaults)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 405)) return defaults
        return defaults
      }
    },
  })
}

// ------------------------------------------------------------------ prints

export type PrintFormat =
  | 'interim' | 'summarised' | 'semi' | 'final' | 'nonmed_summary' | 'nonmed' | 'pharmacy' | 'sponsor_tpa'
  | 'sponsor_corporate' | 'sponsor_govt' | 'detailed_gst' | 'estimate' | 'casesheet' | 'checkout'

export const printUrl = (admissionId: string, fmt: PrintFormat, opts: { letterhead?: boolean; download?: boolean; no?: string } = {}) =>
  apiUrl(`/ipbilling/print/${admissionId}/${fmt}`, { letterhead: opts.letterhead === false ? 'false' : undefined, download: opts.download ? 'true' : undefined, no: opts.no }, true)

export const PAY_MODES = ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'WALLET'] as const
export type PayMode = typeof PAY_MODES[number]
export const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK: 'Bank transfer', CHEQUE: 'Cheque', WALLET: 'Wallet', INSURANCE: 'Sponsor',
  DEPOSIT: 'Advance', SALARY: 'Salary recovery',
}
export const KIND_LABEL: Record<string, string> = { DEPOSIT: 'Advance', PAYMENT: 'Payment', REFUND: 'Refund', ADJUSTMENT: 'Adjusted' }

export const WARD_CATEGORIES = ['General', 'Semi-Private', 'Private', 'Deluxe', 'ICU', 'HDU', 'NICU', 'PICU', 'Isolation', 'Day Care', 'ER']
