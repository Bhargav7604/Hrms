export type Payer = 'Self' | 'Corporate' | 'Insurance' | 'Government Scheme'
export type DiscType = '%' | '₹'

export interface Line {
  key: string
  kind: 'service' | 'consultation' | 'package' | 'charge'
  service_id?: string | null
  package_id?: string | null
  charge_id?: string | null
  code?: string | null
  name: string
  category?: string | null
  consultant_id?: string | null
  consultant_name?: string | null
  qty: number
  rate: number
  disc_type: DiscType
  disc_value: number
  tax_percent: number
  rate_editable?: boolean
  follow_up?: boolean
}

export interface PayLine { mode: string; amount: number; reference?: string | null }

export interface DraftState {
  lines: Line[]
  payer: Payer
  category?: string | null
  sponsor_id?: string | null
  sponsor_name?: string | null
  camp_id?: string | null
  patient_share_type: DiscType
  patient_share_value: number
  bill_disc_type: DiscType
  bill_disc_value: number
  discount_remarks?: string | null
  prescribed_by?: string | null
  lead_source?: string | null
  pay_lines: PayLine[]
  coupon_code?: string | null
  referral?: string | null
  notes?: string | null
}

export interface Totals {
  lines: { key: string; gross: number; discount: number; tax: number; net: number }[]
  gross: number; item_discount: number; bill_discount: number; discount: number; tax: number; net: number
  patient_payable: number; sponsor_amount: number; paid_now: number; balance: number; saved: number; discount_percent: number; items: number
}

export interface CounterPatient {
  id: string; uhid: string; name: string; age?: number | null; gender?: string | null; phone?: string | null; aadhaar?: string | null
  registered_at?: string; category: string; payer_type: string; sponsor_id?: string | null; sponsor?: string | null; status?: string
  encounter?: { id: string; code: string; type: string; kind: 'OP' | 'IP' | 'ER'; status: string; started_at?: string } | null
}

export interface Bill {
  id: string; code: string; status: string; type?: string; patient_id: string; encounter_id?: string | null; payer?: string
  gross?: number; discount?: number; tax?: number; net?: number; paid?: number; balance?: number; billed_at?: string | null
  created_at?: string; counter?: string; visit?: { doctor?: string; doctor_id?: string; visit_type?: string; reason?: string; priority?: string; code?: string } | null
  state: DraftState; totals: Totals; label: { status: string; sub: string | null }; patient: CounterPatient; deposit_balance?: number
  approval?: { id: string; code: string; status: string; approver_role: string; summary?: string; comments?: string } | null
  unbilled?: { id: string; code?: string; description?: string; amount?: number; source?: string; charged_at?: string }[]
  payments?: { id: string; code: string; mode: string; amount: number; reference?: string; kind?: string; paid_at?: string; status?: string; mode_corrected_from?: string | null }[]
  approval_required?: boolean
  patient_due?: number | null; sponsor_due?: number | null; refundable?: number
  charges?: { id: string; code: string; description: string; qty: number; rate: number; amount: number; discount: number; line_net?: number; consultant_name?: string; status: string }[]
}

export interface CounterContext {
  pay_modes: string[]; lead_sources: string[]; payers: Payer[]; categories: string[]; discount_approval_percent: number
  follow_up_days: number; require_lead_source: boolean; sponsors: { id: string; name: string; type?: string; discount_percent?: number | null }[]
  camps: { id: string; name: string; date?: string }[]; can_refund: boolean; can_correct_mode: boolean; allow_line_discount: boolean
  print_on_save: boolean; default_payment_mode: string; user: string
}

export interface CatalogItem {
  kind: Line['kind']; service_id?: string; package_id?: string; consultant_id?: string; code?: string; name: string; category?: string
  rate: number; tax_percent?: number; rate_editable?: boolean; department?: string; specialization?: string; follow_up?: boolean
  new_fee?: number; follow_up_fee?: number; last_visit?: string | null; inclusions?: string[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** Same arithmetic as the server (opbilling.compute) for instant feedback while typing. */
export function computeTotals(s: DraftState): Totals {
  let gross = 0
  let itemDisc = 0
  let taxPre = 0
  const lines = s.lines.map((ln) => {
    const g = r2((Number(ln.qty) || 0) * (Number(ln.rate) || 0))
    const dv = Number(ln.disc_value) || 0
    const disc = Math.min(ln.disc_type === '%' ? r2((g * dv) / 100) : r2(dv), g)
    const tax = r2(((g - disc) * (Number(ln.tax_percent) || 0)) / 100)
    gross += g
    itemDisc += disc
    taxPre += tax
    return { key: ln.key, gross: g, discount: disc, tax, net: r2(g - disc + tax) }
  })
  const sub = gross - itemDisc
  const bv = Number(s.bill_disc_value) || 0
  const billDisc = Math.min(s.bill_disc_type === '%' ? r2((sub * bv) / 100) : r2(bv), sub)
  const tax = sub > 0 ? r2((taxPre * (sub - billDisc)) / sub) : 0
  const net = r2(sub - billDisc + tax)
  const sv = Number(s.patient_share_value) || 0
  const patient = s.payer === 'Self' ? net : Math.min(s.patient_share_type === '%' ? r2((net * sv) / 100) : r2(sv), net)
  const paid = r2(s.pay_lines.reduce((a, p) => a + (Number(p.amount) || 0), 0))
  const discount = r2(itemDisc + billDisc)
  return {
    lines, gross: r2(gross), item_discount: r2(itemDisc), bill_discount: billDisc, discount, tax, net, patient_payable: patient,
    sponsor_amount: r2(net - patient), paid_now: paid, balance: r2(patient - paid), saved: discount,
    discount_percent: gross ? Math.round((discount / gross) * 10000) / 100 : 0, items: s.lines.length,
  }
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k${Date.now()}${Math.random().toString(16).slice(2)}`)
export const REF_MODES = new Set(['CARD', 'UPI', 'WALLET', 'BANK', 'CHEQUE'])
