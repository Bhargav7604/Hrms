export type FieldType =
  | 'text' | 'textarea' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'time'
  | 'select' | 'multiselect' | 'boolean' | 'phone' | 'email' | 'ref' | 'lines' | 'signature'
  | 'file' | 'rating' | 'tags'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  kind?: string // original shorthand: patient, doctor, department, ...
  required?: boolean
  options?: string[]
  ref?: string
  filter?: Record<string, unknown>
  default?: unknown
  help?: string
  placeholder?: string
  min?: number
  max?: number
  unit?: string
  width?: 'full' | 'half' | 'third'
  rows?: number
  fields?: FieldDef[]
  readonly?: boolean
  hidden?: boolean
  /** Field configuration: show only the last 4 characters until revealed */
  mask?: boolean
  /** Field configuration: false = can be set when the record is created, not changed later */
  editable?: boolean
  /** Field configuration applied (label/required/hidden/default may differ from the definition) */
  configured?: boolean
  order?: number
}

export type Tone = 'primary' | 'success' | 'danger' | 'warning' | 'neutral'

export interface TransitionDef {
  from: string[] | '*'
  to: string
  label: string
  roles?: string[]
  require?: string[]
  fields?: string[]
  stamp?: string
  confirm?: string
  tone: Tone
}

export interface EntityDef {
  key: string
  fqn: string
  module: string
  label: string
  singular: string
  prefix: string
  description?: string
  icon?: string
  table: string
  scope: Record<string, unknown>
  patient: boolean | 'optional'
  encounter: boolean | 'optional'
  employee: boolean | 'optional'
  fields: FieldDef[]
  list: string[]
  statuses?: string[]
  transitions: TransitionDef[]
  restricted: boolean
  readonly: boolean
  code_editable: boolean
  date_field?: string
  sort: string
  /** Master shared by every branch (others are listed per active branch) */
  shared?: boolean
  code_pattern?: string
}

export interface PageDef { key: string; label: string; icon?: string; roles?: string[] }

export type Level = 'none' | 'view' | 'edit'

export interface EntityAccess { read: boolean; write: boolean; break_glass: boolean; level?: Level }

export interface ModuleDef {
  no: number
  id: string
  suite: string
  name: string
  icon: string
  summary: string
  features: string[]
  roles: string[]
  read_roles: string[]
  pages: PageDef[]
  entities: EntityDef[]
  access: { read: boolean; write: boolean; pages: string[]; page_levels?: Record<string, Level>; entities: Record<string, EntityAccess> }
}

export interface Suite { id: string; no: number; name: string; short: string }

export interface User {
  id: string
  username: string
  name: string
  role: string
  employee_id?: string | null
  /** custom role (permission set) when assigned; `role` is then its base role */
  perm_role?: string | null
  branches?: string[]
}

export interface Branch { code: string; name: string; no: number; city?: string | null; state?: string | null }

export interface Meta {
  hospital: { name: string; branch: string; branch_name?: string; timezone: string }
  /** active branch code and the branches this user may switch to */
  branch?: string
  branches?: Branch[]
  /** label of every record type (including ones this role cannot open) */
  entity_labels?: Record<string, string>
  suites: Suite[]
  roles: Record<string, string>
  modules: ModuleDef[]
  user: User
  features: { ai_llm: boolean; notify_mode: string }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any> & {
  id: string
  code?: string
  status?: string
  title?: string
  patient_id?: string
  created_at?: string
  _refs?: Record<string, string>
  _transitions?: TransitionDef[]
}

export interface ListResult {
  rows: Rec[]
  total: number
  page: number
  limit: number
  refs: Record<string, string>
}

export interface Kpi { label: string; value: number; format: 'number' | 'currency' | 'percent' | 'minutes' }

export interface ModuleStats {
  entities: Record<string, { total: number; today: number; by_status: Record<string, number> }>
  kpis: Kpi[]
}

export interface AuditRow {
  id: string
  at: string
  user_name: string
  role: string
  action: string
  module?: string
  entity?: string
  record_code?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  note?: string
}
