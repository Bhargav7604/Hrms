import type { Perms, TabKey } from '../api'

export interface SubPage { key: string; label: string; form?: boolean }
export interface TabDef { key: TabKey; label: string; icon: string; subs?: SubPage[]; count?: string; blurb: string }

const form = (key: string, label: string): SubPage => ({ key, label, form: true })

/** The IP chart's module tabs. Sub-pages whose key contains a dot are clinical forms (forms engine keys). */
export const TABS: TabDef[] = [
  { key: 'overview', label: 'Overview', icon: 'Activity', blurb: 'Vitals, recent orders, notes and the visit tracker.' },
  { key: 'forms', label: 'Forms', icon: 'ClipboardList', blurb: 'Every clinical form — search, favourites and the module suites.' },
  { key: 'documents', label: 'Documents', icon: 'FileText', count: 'documents', blurb: 'Uploaded documents for this admission.' },
  { key: 'consent', label: 'Consent', icon: 'FileSignature', count: 'consents', blurb: 'Recorded patient consents — grant and print.' },
  { key: 'cath', label: 'Cath', icon: 'HeartPulse', blurb: 'Cath-lab procedure paperwork.', subs: [
    form('doctor.procedure_note', 'Cath procedure note'), form('ot.preop_checklist', 'Pre-procedure checklist'), form('ot.site_marking', 'Access site marking'),
    form('safety.high_alert_double_check', 'High-alert drug double check'), form('ot.postop_orders', 'Post-procedure orders'),
  ] },
  { key: 'dietary', label: 'Dietary', icon: 'Utensils', blurb: 'Nutrition screening, assessment and diet plans.', subs: [
    form('dietary.progress_note', 'Progress notes'), form('dietary.maternal_nutrition', 'Maternal nutrition'), form('dietary.strongkids', 'Paediatric (STRONGkids)'),
    form('dietary.sga', 'SGA'), form('dietary.nutric', 'NUTRIC score'), form('dietary.reassessment', 'Nutritional re-assessment'), form('dietary.daily_diet', 'Daily diet'),
  ] },
  { key: 'doctor', label: 'Doctor', icon: 'Stethoscope', count: 'doctor', blurb: 'Progress notes, instructions to the ward, assessments and the discharge summary.', subs: [
    { key: 'progress-notes', label: 'Progress notes' }, { key: 'instructions', label: "Doctor's instructions" }, form('discharge.summary', 'IP discharge summary'),
    form('doctor.admission_hp', 'Admission H&P'), form('doctor.progress_soap', 'Progress note (SOAP)'), form('doctor.consultant_visit', 'Consultant visit'),
    form('doctor.cross_consult', 'Cross-consultation'), form('doctor.procedure_note', 'Procedure note'), form('doctor.transfer_note', 'Transfer note'),
    form('doctor.transfusion_order', 'Transfusion order'), form('doctor.high_risk_med_order', 'High-risk medication order'),
    form('doctor.restraint_order', 'Restraint order'), form('doctor.referral_letter', 'Referral letter'), form('doctor.death_note', 'Death note'),
  ] },
  { key: 'hic', label: 'HIC', icon: 'ShieldCheck', blurb: 'Infection precautions and care-bundle checklists.', subs: [
    { key: 'reactive', label: 'Reactive status & isolation' }, form('infection.clabsi', 'CLABSI bundle'), form('infection.cauti', 'CAUTI bundle'), form('infection.vap', 'VAP bundle'),
  ] },
  { key: 'monitoring', label: 'Monitoring', icon: 'LineChart', blurb: 'Critical-care and monitoring flowsheets.', subs: [
    { key: 'vitals', label: 'Vitals chart' }, { key: 'intake-output', label: 'Intake / output' }, form('monitoring.diabetic', 'Diabetic chart (GRBS)'),
    form('monitoring.neuro', 'Neuro observations'),
  ] },
  { key: 'nursing', label: 'Nursing', icon: 'Heart', count: 'nursing', blurb: 'Medication administration, tasks, handover and scored instruments.', subs: [
    { key: 'mar', label: 'Medication administration (MAR)' }, { key: 'tasks', label: 'Tasks' }, { key: 'handover', label: 'Shift handover' },
    { key: 'nursing-notes', label: 'Nursing notes' }, form('nursing.initial_assessment', 'Initial assessment'), form('nursing.morse', 'Morse fall scale'),
    form('nursing.braden', 'Braden scale'), form('nursing.gcs', 'Glasgow coma scale'), form('nursing.pain', 'Pain score'), form('nursing.mews', 'MEWS'),
    form('nursing.rass', 'Sedation (RASS)'), form('nursing.sbar', 'SBAR handover'), form('nursing.paediatric_assessment', 'Paediatric assessment'),
    form('safety.fall_incident', 'Fall incident'), form('safety.pressure_injury', 'Pressure injury'), form('safety.transfusion_monitoring', 'Transfusion monitoring'),
    form('safety.restraint_monitoring', 'Restraint monitoring'), form('safety.medication_error', 'Medication error'),
  ] },
  { key: 'order_desk', label: 'Order Desk', icon: 'ShoppingCart', count: 'order_desk', blurb: 'Investigations, medication indents, pharmacy returns, procedures, grade billing, equipment & cancellations.', subs: [
    { key: 'investigations', label: 'Investigations' }, { key: 'service-request', label: 'Service request' }, { key: 'medication', label: 'Order medication' },
    { key: 'pharmacy-return', label: 'Pharmacy return' }, { key: 'procedure', label: 'Add procedure' }, { key: 'grade-billing', label: 'Grade billing' },
    { key: 'equipment', label: 'Equipment' }, { key: 'cancellations', label: 'Cancellations' },
  ] },
  { key: 'order_medication', label: 'Order Medication', icon: 'Pill', count: 'indents', blurb: 'Raise ward indents and see every medicine on this stay.' },
  { key: 'investigations', label: 'Investigations', icon: 'FlaskConical', count: 'investigations', blurb: 'Order tests and scans, collect payment, track and view reports.' },
  { key: 'ot', label: 'OT', icon: 'Scissors', count: 'ot', blurb: 'Theatre bookings and the paperless OT file.', subs: [
    { key: 'scheduled', label: 'OT scheduled list' }, { key: 'booklet', label: 'OT booklet' },
  ] },
]

/** Order-desk sub-pages the role can use (strict visibility). */
export function orderDeskSubs(p: Perms): SubPage[] {
  const ok: Record<string, boolean> = {
    investigations: p.tabs.investigations, 'service-request': p.order, medication: p.tabs.order_medication, 'pharmacy-return': p.pharmacy_return,
    procedure: p.charge, 'grade-billing': p.charge, equipment: p.equipment || p.void_usage || p.money,
    cancellations: p.void_order || p.void_charge || p.void_indent || p.void_usage,
  }
  return (TABS.find((t) => t.key === 'order_desk')!.subs ?? []).filter((s) => ok[s.key])
}

export function subsFor(tab: TabDef, p: Perms): SubPage[] {
  if (tab.key === 'order_desk') return orderDeskSubs(p)
  return tab.subs ?? []
}
