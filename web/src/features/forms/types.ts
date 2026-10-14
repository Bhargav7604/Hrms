/** Clinical form definitions and entries (mirrors backend/app/forms/spec.py and engines/forms.py). */

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet' | 'cyan' | 'pink'

export interface Cond {
  field?: string
  eq?: unknown
  ne?: unknown
  in?: unknown[]
  nin?: unknown[]
  gt?: number
  gte?: number
  lt?: number
  lte?: number
  truthy?: boolean
  all?: Cond[]
  any?: Cond[]
}

export interface Option { value: string; label?: string; score?: number; help?: string }
export interface Range { min?: number; max?: number; lt?: number; score: number; label?: string }

export type FormFieldType =
  | 'text' | 'textarea' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'time' | 'select' | 'multiselect'
  | 'boolean' | 'phone' | 'email' | 'ref' | 'lines' | 'signature' | 'file' | 'rating' | 'tags'
  | 'choice' | 'yesno' | 'scale' | 'computed' | 'info'

export interface FormField {
  key: string
  label: string
  type: FormFieldType
  required?: boolean
  required_if?: Cond
  show_if?: Cond
  options?: (Option | string)[]
  ref?: string
  filter?: Record<string, unknown>
  kind?: string
  default?: unknown
  prefill?: string
  help?: string
  placeholder?: string
  unit?: string
  min?: number
  max?: number
  step?: number
  rows?: number
  width?: 'full' | 'half' | 'third' | 'quarter'
  fields?: FormField[]
  score_ranges?: Range[]
  score_map?: Record<string, number>
  score_value?: boolean
  compute?: { fn: string; args: string[]; decimals?: number }
  ui?: 'segmented' | 'radio' | 'dropdown' | 'chips'
  dictation?: boolean
  templates?: boolean
  copy_from?: string[]
  tone?: Tone
  readonly?: boolean
}

export interface Section {
  key: string
  title: string
  description?: string
  tone?: Tone
  show_if?: Cond
  collapsed?: boolean
  fields: FormField[]
}

export interface Band {
  label: string
  tone: Tone
  min?: number
  max?: number
  lt?: number
  action?: string
  reassess_hours?: number
  task?: { text: string; priority: string; category: string }
  alert?: boolean
}

export interface ScoreDef {
  method: 'sum' | 'max' | 'min' | 'value' | 'percent_yes' | 'count_yes'
  items: string[]
  label: string
  min?: number
  max?: number
  decimals?: number
  unit?: string
  lower_is_worse?: boolean
}

export interface Access { view: boolean; fill: boolean; sign: boolean }

export interface FormSummary {
  key: string
  suite: string
  suite_name: string
  also_in: string[]
  title: string
  short?: string
  description?: string
  icon?: string
  group?: string
  order: number
  roles: string[]
  sign_roles: string[]
  one_per_admission: boolean
  multi_entry: boolean
  restricted: boolean
  component?: 'io_flowsheet' | null
  scored: boolean
  score_label?: string
  match: string[]
  fields: number
  access: Access
  state?: {
    count: number
    draft: { id: string; updated_at?: string; noted_at?: string } | null
    latest: { id: string; status: string; noted_at?: string; score?: number | null; risk_band?: string | null; risk_tone?: Tone | null; next_due_at?: string | null } | null
  }
}

export interface FormDef extends FormSummary {
  version: number
  reassess_hours?: number
  summary?: string[]
  score?: ScoreDef | null
  bands: Band[]
  sections: Section[]
  import_from: { form: string; label?: string; map: Record<string, string> }[]
  mirror: string[]
}

export interface SuiteInfo { id: string; name: string; icon: string; tone: Tone; description: string; count: number }

export interface DefsResponse { suites: SuiteInfo[]; forms: FormSummary[]; favourites: string[]; recent: string[] }

export type Answers = Record<string, unknown>

export interface EntryRow {
  id: string
  code?: string
  form_key: string
  form_title: string
  short?: string
  suite?: string
  group?: string
  status: 'Draft' | 'Signed' | 'Amended'
  noted_at?: string
  patient_id: string
  patient_name?: string
  uhid?: string
  encounter_id?: string | null
  ot_booking?: string | null
  score?: number | null
  score_label?: string | null
  risk_band?: string | null
  risk_tone?: Tone | null
  summary?: string | null
  author?: string | null
  author_name?: string
  signed_by_name?: string
  signed_at?: string | null
  amended_at?: string | null
  next_due_at?: string | null
  overdue?: boolean
  updated_at?: string
  restricted?: boolean
}

export interface Amendment {
  at: string
  by?: string
  by_name?: string
  reason: string
  fields: string[]
  before: Answers
  after: Answers
  score_before?: number | null
  score_after?: number | null
  band_before?: string | null
  band_after?: string | null
}

export interface Entry extends EntryRow {
  answers: Answers
  refs: Record<string, string>
  band?: Band | null
  access: Access
  amendments: Amendment[]
  linked?: Record<string, string>
  effect_notes?: string[] | null
  last_edited_by?: string
}

export interface FormContext {
  patientId: string
  encounterId?: string
}
