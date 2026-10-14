import type { ComponentType, ReactNode } from 'react'
import * as Forms from '@/features/forms'
import { Badge, cn, Textarea, type BadgeTone } from '@/components/ui'
import { Icon } from '@/lib/icons'
import { hm, type ClockState, type ErState, type TriageBrief } from './api'

// ------------------------------------------------------------------ triage

const TRIAGE_STYLE: Record<string, string> = {
  red: 'bg-red-600 text-white ring-red-700/30',
  orange: 'bg-orange-500 text-white ring-orange-600/30',
  yellow: 'bg-amber-300 text-amber-950 ring-amber-500/40',
  green: 'bg-emerald-600 text-white ring-emerald-700/30',
  black: 'bg-slate-900 text-white ring-slate-500/40 dark:bg-black',
}
export const TRIAGE_DOT: Record<string, string> = {
  red: 'bg-red-600', orange: 'bg-orange-500', yellow: 'bg-amber-400', green: 'bg-emerald-600', black: 'bg-slate-900 dark:bg-slate-200',
}
export const TRIAGE_BORDER: Record<string, string> = {
  red: 'border-l-red-600', orange: 'border-l-orange-500', yellow: 'border-l-amber-400', green: 'border-l-emerald-600', black: 'border-l-slate-900 dark:border-l-slate-300',
}

export function TriagePill({ triage, short, className }: { triage?: TriageBrief | null; short?: boolean; className?: string }) {
  if (!triage) return <span className={cn('text-xs text-ink-3', className)}>Not triaged</span>
  const label = short ? (triage.priority ? `${triage.label.split(' — ')[0]} ${triage.priority}` : triage.label.split(' — ')[0]) : triage.label
  return (
    <span title={triage.label}
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
        TRIAGE_STYLE[triage.color ?? triage.key] ?? 'bg-slate-200 text-slate-800', className)}>
      {label}
    </span>
  )
}

export function targetText(min?: number | null) {
  if (min === null || min === undefined) return 'No target'
  return min === 0 ? 'Immediate' : `${min} min`
}

// ------------------------------------------------------------------ time, state

const CLOCK_TEXT: Record<string, string> = {
  ok: 'text-ink', near: 'text-amber-700 dark:text-amber-300', breached: 'text-red-600 dark:text-red-400', done: 'text-ink-2',
}

/** Time in ER with breach colouring (and a text cue, never colour alone). */
export function TimeInEr({ minutes, state, className }: { minutes: number | null; state: 'ok' | 'near' | 'breached' | 'done'; className?: string }) {
  return (
    <span className={cn('tabular-nums font-medium', CLOCK_TEXT[state], className)}
      title={state === 'breached' ? 'Over the ER length-of-stay target' : state === 'near' ? 'Approaching the length-of-stay target' : undefined}>
      {hm(minutes)}{state === 'breached' && <span className="ml-1 text-[10px] font-semibold uppercase">over</span>}
    </span>
  )
}

const CLOCK_BADGE: Record<ClockState, { tone: BadgeTone; label: string } | null> = {
  ok: { tone: 'green', label: 'Within target' }, near: { tone: 'amber', label: 'Due soon' }, breached: { tone: 'red', label: 'Target breached' },
  met: { tone: 'green', label: 'Seen in target' }, missed: { tone: 'amber', label: 'Seen after target' }, none: null,
}

export function ClockBadge({ state }: { state: ClockState }) {
  const b = CLOCK_BADGE[state]
  return b ? <Badge tone={b.tone} dot>{b.label}</Badge> : null
}

const STATE_TONE: Record<ErState, BadgeTone> = { Active: 'green', 'Awaiting billing': 'amber', Closed: 'gray' }
export function StateBadge({ state }: { state: ErState }) {
  return <Badge tone={STATE_TONE[state]} dot>{state}</Badge>
}

export function UnmappedBadge() {
  return <Badge tone="amber" className="gap-1"><Icon name="TriangleAlert" className="size-3" /> UHID not mapped</Badge>
}

export const FLAG: Record<string, { label: string; short: string; tone: BadgeTone }> = {
  mlc: { label: 'Medico-legal case', short: 'MLC', tone: 'violet' },
  allergy: { label: 'Allergies recorded', short: 'ALG', tone: 'amber' },
  critical: { label: 'Critical result awaiting acknowledgement', short: 'CRIT', tone: 'red' },
  breach: { label: 'Triage target breached — not yet seen by a doctor', short: 'WAIT', tone: 'red' },
  unmapped: { label: 'UHID not mapped (temporary record)', short: 'UNID', tone: 'amber' },
}

export function Flags({ flags, only }: { flags: string[]; only?: string[] }) {
  const list = flags.filter((f) => FLAG[f] && (!only || only.includes(f)))
  if (!list.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((f) => <span key={f} title={FLAG[f].label}><Badge tone={FLAG[f].tone}>{FLAG[f].short}</Badge></span>)}
    </span>
  )
}

// ------------------------------------------------------------------ clinical form controls

/** Tap-to-select segmented buttons (clinical checklists). Clicking the active option clears it. */
export function Seg<T extends string | number>({ options, value, onChange, disabled, className, labels }: {
  options: readonly T[]; value: T | null | undefined; onChange: (v: T | null) => void; disabled?: boolean; className?: string
  labels?: Partial<Record<string, string>>
}) {
  return (
    <div role="radiogroup" className={cn('flex w-full flex-wrap rounded-lg bg-surface-2 p-0.5 ring-1 ring-line', className)}>
      {options.map((o) => {
        const on = value === o
        return (
          <button key={String(o)} type="button" role="radio" aria-checked={on} disabled={disabled}
            onClick={() => onChange(on ? null : o)}
            className={cn('min-w-8 flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed',
              on ? 'bg-brand-700 text-white shadow-sm' : 'text-ink-2 hover:bg-surface hover:text-ink', disabled && !on && 'opacity-60')}>
            {labels?.[String(o)] ?? String(o)}
          </button>
        )
      })}
    </div>
  )
}

const SECTION_TONE: Record<string, string> = {
  blue: 'bg-sky-50 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200',
  pink: 'bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
  green: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
  violet: 'bg-violet-50 text-violet-900 dark:bg-violet-500/10 dark:text-violet-200',
  amber: 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
  slate: 'bg-surface-2 text-ink',
}

export function SectionHead({ no, title, tone = 'slate', icon = 'ClipboardList', right }: {
  no?: number; title: string; tone?: keyof typeof SECTION_TONE; icon?: string; right?: ReactNode
}) {
  return (
    <div className={cn('mb-3 mt-5 flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold first:mt-0', SECTION_TONE[tone])}>
      <span className="flex items-center gap-2"><Icon name={icon} className="size-4 opacity-70" />{no ? `${no}. ` : ''}{title}</span>
      {right}
    </div>
  )
}

export function Lbl({ children, required }: { children: ReactNode; required?: boolean }) {
  return <span className="mb-1 block text-xs font-medium text-ink-2">{children}{required && <span className="ml-0.5 text-red-600">*</span>}</span>
}

// Narrative helpers from the clinical-forms package (dictation, text templates) when it provides them.
type AnyCmp = ComponentType<Record<string, unknown>>
const forms = Forms as unknown as Record<string, AnyCmp | undefined>

/** Narrative textarea with dictation and text templates (clinical-forms package) when available. */
export function NarrativeField({ label, value, onChange, rows = 3, disabled, placeholder, context, required }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean; placeholder?: string; context?: string
  required?: boolean
}) {
  const Dictate = forms.DictationButton
  const Templates = forms.TemplatePicker
  const append = (t: string) => onChange(value ? `${value.replace(/\s+$/, '')}\n${t}` : t)
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Lbl required={required}>{label}</Lbl>
        {!disabled && (Dictate || Templates) && (
          <span className="flex items-center gap-1">
            {Templates && <Templates context={context ?? label} field={label} onPick={append} onInsert={append} />}
            {Dictate && <Dictate onText={append} onTranscript={append} onResult={append} />}
          </span>
        )}
      </div>
      <Textarea rows={rows} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

// ------------------------------------------------------------------ board actions

export interface ActionDef { key: string; label: string; letter?: string; icon: string }
export const ACTIONS: ActionDef[] = [
  { key: 'assessment', label: 'Assessment', letter: 'A', icon: 'Stethoscope' },
  { key: 'discharge_summary', label: 'Discharge summary', letter: 'D', icon: 'FileText' },
  { key: 'lab_reports', label: 'Lab reports', icon: 'FlaskConical' },
  { key: 'pacs', label: 'PACS', letter: 'P', icon: 'ScanLine' },
  { key: 'admission_notes', label: 'Admission notes / disposition', icon: 'LogOut' },
  { key: 'add_details', label: 'Add patient details', icon: 'UserPen' },
  { key: 'order_medicine', label: 'Order medicine', icon: 'Pill' },
  { key: 'investigations', label: 'Investigations', icon: 'TestTubeDiagonal' },
  { key: 'patient_movement', label: 'Patient movement', icon: 'BedDouble' },
  { key: 'doctor_visit', label: 'Doctor visit', icon: 'UserRoundCheck' },
  { key: 'initial_assessment', label: 'Initial assessment', icon: 'Eye' },
  { key: 'documents', label: 'Documents', icon: 'Paperclip' },
]

export function ActionGlyph({ a, className }: { a: ActionDef; className?: string }) {
  return a.letter
    ? <span className={cn('grid size-5 place-items-center rounded text-[11px] font-bold', className)}>{a.letter}</span>
    : <Icon name={a.icon} className={cn('size-4', className)} />
}

export function Kv({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-0.5 break-words text-sm text-ink">{children ?? '—'}</div>
    </div>
  )
}
