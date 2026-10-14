import type { Param, WorkRow } from '@/pages/bespoke/lab-worklist'

export interface DeltaCheck {
  parameter: string; current?: string | null; previous?: string | null; previous_at?: string | null; previous_order?: string | null
  change?: number | null; change_percent?: number | null; limit?: string; failed: boolean; hold: boolean
}
export interface ReflexSuggestion {
  rule_id: string; rule?: string | null; service_id?: string | null; test?: string | null; reason?: string; action: string
  comment?: string | null; status: 'Suggested' | 'Ordered' | 'Dismissed'; order_code?: string | null
}
export interface PrevResult { order_id: string; code: string; verified_at?: string | null; values: { parameter: string; value?: string | null; flag?: string | null; unit?: string | null }[] }

export interface PatientParam extends Param { method?: string | null; note?: string | null; display_text?: string | null; range_basis?: string | null; decimals?: number | null }

/** Rows of the lab engine: the orders worklist shape plus bed, visit and LIS data. */
export interface LabRow extends WorkRow {
  ward_id?: string | null; ward?: string | null; bed?: string | null; ip_no?: string | null; patient_type: 'IP' | 'OP' | 'ER'
  recollect_reason?: string | null; recollect_count?: number | null; delta_checks?: DeltaCheck[]; reflex_suggestions?: ReflexSuggestion[]
  interface_values?: Record<string, string> | null; param_notes?: Record<string, string> | null; micro?: MicroReport | null
  send_out?: string | null; outsourced_to?: string | null; print_count?: number | null; delta_reviewed_at?: string | null; delta_reviewed_by?: string | null
  patient: WorkRow['patient'] & { sex?: string | null; age_label?: string | null; phone?: string | null }
}

export interface SheetRow extends LabRow {
  parameters: PatientParam[]; method?: string | null; interpretation?: string | null; previous: PrevResult[]
  delta_rules: Record<string, { max_change_percent?: number | null; max_change_absolute?: number | null; window_days?: number; action?: string }>
}

export interface MicroOrganism {
  organism: string; colony_count?: string | null; significance?: string | null; resistance: string[]
  sensitivity: { antibiotic: string; interpretation: 'S' | 'I' | 'R'; mic?: string | null }[]
}
export interface MicroReport {
  specimen?: string | null; gram_stain?: string | null; culture_result: string; incubation_hours?: number | null
  organisms: MicroOrganism[]; comments?: string | null; preliminary_at?: string | null; preliminary_by?: string | null; final_at?: string | null
  updated_by?: string | null
}

export interface ReportRow {
  parameter: string; value?: string | null; interface_value?: string | null; normal?: string | null; unit?: string | null; ref_range?: string | null
  method?: string | null; note?: string | null; alarm?: string | null; flag?: string | null; flag_code?: string | null; abnormal: boolean
}
export interface ReportTemplate {
  name?: string | null; layout?: string | null; header_note?: string | null; signatory_1_name?: string | null; signatory_1_designation?: string | null
  signatory_2_name?: string | null; signatory_2_designation?: string | null; footer_text?: string | null; show_previous?: boolean | null
}
export interface Report {
  id: string; code: string; test: string; short_name?: string | null; section?: string | null; method?: string | null; sample_type?: string | null
  barcode?: string | null; priority?: string | null; ordered_at?: string | null; collected_at?: string | null; resulted_at?: string | null
  verified_at?: string | null; status: string; released: boolean; resulted_by?: string | null; verified_by?: string | null
  ordering_doctor?: string | null; critical: boolean; acknowledged_by?: string | null; rows: ReportRow[]; abnormal: number
  result?: string | null; impression?: string | null; interpretation?: string | null; micro?: MicroReport | null; print_count: number
  last_printed_at?: string | null; rollbacks: { at: string; by: string; reason: string }[]; amended_at?: string | null; tat_minutes?: number | null
  outsourced?: { lab?: string | null; external_ref?: string | null; report_file?: string | null } | null; previous: PrevResult[]; template: ReportTemplate
}
export interface ReportGroup {
  patient: { id: string; name?: string | null; uhid?: string | null; gender?: string | null; age?: string | null; phone?: string | null }
  patient_type: 'IP' | 'OP' | 'ER'
  encounter: { ip_no?: string | null; visit_no?: string | null; type?: string | null; status?: string | null; ward?: string | null; bed?: string | null
    consultant?: string | null; department?: string | null; admitted_at?: string | null; ref_doctor?: string | null }
  reports: Report[]
}
export interface ReportView { groups: ReportGroup[]; hospital: { name: string; branch: string }; generated_at: string }

export const PATIENT_TYPE_LABEL: Record<string, string> = { IP: 'In-patient', OP: 'Out-patient', ER: 'Emergency' }
