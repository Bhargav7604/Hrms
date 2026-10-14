/** Form field controls: every Vlack field type plus scored choices, yes/no, 0–10 scales, computed values and info. */
import { Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { FieldInput } from '@/components/fields'
import { Badge, cn } from '@/components/ui'
import { Icon } from '@/lib/icons'
import type { FieldDef } from '@/lib/types'
import { formatAnswer, isEmpty, itemScore, optionOf, TONE_RING } from './logic'
import { NarrativeTools } from './narrative'
import type { Answers, FormField, Option } from './types'

export const SPAN: Record<string, string> = {
  full: 'col-span-12',
  half: 'col-span-12 md:col-span-6',
  third: 'col-span-12 sm:col-span-6 lg:col-span-4',
  quarter: 'col-span-12 sm:col-span-6 lg:col-span-3',
}

export function toFieldDef(f: FormField): FieldDef {
  const type = f.type === 'choice' || f.type === 'yesno' ? 'select' : f.type === 'scale' || f.type === 'computed' ? 'number' : f.type === 'info' ? 'text' : f.type
  return {
    key: f.key, label: f.label, type, kind: f.kind, required: f.required, ref: f.ref, filter: f.filter, help: f.help,
    placeholder: f.placeholder, min: f.min, max: f.max, unit: f.unit, rows: f.rows, width: 'full',
    options: f.options?.map((o) => (typeof o === 'string' ? o : o.value)),
    fields: f.fields?.map(toFieldDef),
  }
}

const opts = (f: FormField): Option[] => (f.options ?? []).map((o) => (typeof o === 'string' ? { value: o } : o))

function ScorePill({ score }: { score?: number | null }) {
  if (score === undefined || score === null) return null
  return <span className="ml-auto shrink-0 rounded bg-surface-2 px-1.5 text-[11px] font-semibold tabular text-ink-2 ring-1 ring-line">{score > 0 ? `+${score}` : score}</span>
}

function SegmentedChoice({ f, value, onChange, disabled, invalid }: { f: FormField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; invalid?: boolean }) {
  const list = opts(f)
  return (
    <div role="radiogroup" aria-label={f.label}
      className={cn('flex flex-wrap gap-0.5 rounded-lg border bg-surface-2 p-0.5', invalid ? 'border-red-500' : 'border-line-2')}>
      {list.map((o) => {
        const on = value === o.value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled} title={o.help}
            onClick={() => onChange(on && !f.required ? null : o.value)}
            className={cn('min-h-8 flex-1 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-default',
              on ? 'bg-brand-800 text-white shadow-sm dark:bg-brand-600' : 'text-ink-2 hover:bg-surface hover:text-ink')}>
            {o.label ?? o.value}
            {f.type === 'choice' && o.score !== undefined && <span className={cn('ml-1 tabular text-[10px]', on ? 'text-white/80' : 'text-ink-3')}>({o.score})</span>}
          </button>
        )
      })}
    </div>
  )
}

function RadioChoice({ f, value, onChange, disabled, invalid }: { f: FormField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; invalid?: boolean }) {
  return (
    <div role="radiogroup" aria-label={f.label} className={cn('grid gap-1', (f.options?.length ?? 0) > 3 && 'sm:grid-cols-2', invalid && 'rounded-lg ring-1 ring-red-500')}>
      {opts(f).map((o) => {
        const on = value === o.value
        return (
          <label key={o.value}
            className={cn('flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors',
              on ? 'border-brand-600 bg-brand-50 text-ink ring-1 ring-brand-600/30 dark:bg-brand-500/10' : 'border-line bg-surface hover:bg-surface-2',
              disabled && 'cursor-default opacity-80')}>
            <input type="radio" className="mt-0.5 size-4 accent-brand-700" name={f.key} checked={on} disabled={disabled}
              onChange={() => onChange(o.value)} onClick={() => { if (on && !f.required) onChange(null) }} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{o.label ?? o.value}</span>
              {o.help && <span className="block text-xs text-ink-3">{o.help}</span>}
            </span>
            {f.type === 'choice' && <ScorePill score={o.score} />}
          </label>
        )
      })}
    </div>
  )
}

function Scale({ f, value, onChange, disabled }: { f: FormField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const lo = f.min ?? 0, hi = f.max ?? 10
  const steps = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  const tone = (n: number) => { const r = (n - lo) / Math.max(1, hi - lo); return r < 0.35 ? 'bg-emerald-600' : r < 0.65 ? 'bg-amber-500' : 'bg-red-600' }
  return (
    <div role="radiogroup" aria-label={f.label} className="flex flex-wrap gap-1">
      {steps.map((n) => {
        const on = Number(value) === n && !isEmpty(value)
        return (
          <button key={n} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(on ? null : n)}
            className={cn('size-8 rounded-md text-sm font-semibold tabular ring-1 ring-inset transition-colors',
              on ? `${tone(n)} text-white ring-transparent` : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
            {n}
          </button>
        )
      })}
    </div>
  )
}

function Computed({ f, value }: { f: FormField; value: unknown }) {
  const s = itemScore(f, value)
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-dashed border-line-2 bg-surface-2 px-3 text-sm">
      <Icon name="Calculator" className="size-3.5 text-ink-3" />
      <span className={cn('font-semibold tabular', isEmpty(value) ? 'text-ink-3' : 'text-ink')}>{isEmpty(value) ? '—' : String(value)}</span>
      {f.unit && !isEmpty(value) && <span className="text-xs text-ink-3">{f.unit}</span>}
      {s !== null && <ScorePill score={s} />}
    </div>
  )
}

export interface ControlProps {
  f: FormField
  value: unknown
  onChange: (v: unknown) => void
  error?: string
  errors?: Record<string, string>
  disabled?: boolean
  refs?: Record<string, string>
  patientId?: string
  encounterId?: string
  formKey?: string
  compact?: boolean
  row?: Answers
}

/** The input for one form field (no label). */
export function FormControl({ f, value, onChange, error, errors, disabled, refs, patientId, compact }: ControlProps) {
  const invalid = !!error
  switch (f.type) {
    case 'choice':
      return f.ui === 'segmented' || compact ? <SegmentedChoice f={f} value={value} onChange={onChange} disabled={disabled} invalid={invalid} />
        : <RadioChoice f={f} value={value} onChange={onChange} disabled={disabled} invalid={invalid} />
    case 'yesno':
      return <SegmentedChoice f={f} value={value} onChange={onChange} disabled={disabled} invalid={invalid} />
    case 'select':
      if (f.ui === 'segmented' || f.ui === 'radio') return <SegmentedChoice f={f} value={value} onChange={onChange} disabled={disabled} invalid={invalid} />
      return <FieldInput field={toFieldDef(f)} value={value} onChange={onChange} error={error} disabled={disabled} compact={compact} refs={refs} patientId={patientId} />
    case 'scale':
      return <Scale f={f} value={value} onChange={onChange} disabled={disabled} />
    case 'computed':
      return <Computed f={f} value={value} />
    case 'info':
      return null
    case 'lines':
      return <FormLines f={f} value={value as Answers[] | null} onChange={onChange} disabled={disabled} errors={errors} refs={refs} patientId={patientId} />
    case 'boolean':
      return (
        <label className={cn('inline-flex h-9 cursor-pointer items-center gap-2 text-sm text-ink', disabled && 'opacity-60')}>
          <input type="checkbox" className="size-4 accent-brand-700" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          {compact ? '' : 'Yes'}
        </label>
      )
    case 'textarea':
      return (
        <FieldInput field={{ ...toFieldDef(f), placeholder: f.placeholder ?? `Enter ${f.label.replace(/^\d+\.\s*/, '').toLowerCase()}…` }} value={value}
          onChange={onChange} error={error} disabled={disabled} compact={compact} />
      )
    default:
      return (
        <FieldInput field={toFieldDef(f)} value={value} onChange={onChange} error={error} disabled={disabled} compact={compact} refs={refs}
          patientId={patientId} />
      )
  }
}

/** Label + tools + control + help/error for one field. */
export function FormFieldBlock(p: ControlProps & { required?: boolean; source?: string; extra?: ReactNode }) {
  const { f, value, onChange, error, disabled, patientId, encounterId, formKey, required, source } = p
  if (f.type === 'info') {
    return (
      <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', TONE_RING[f.tone ?? 'blue'])}>
        <Icon name="Info" className="mt-0.5 size-4 shrink-0" /> <span>{f.help}</span>
      </div>
    )
  }
  const narrative = f.type === 'textarea' && !disabled
  return (
    <div className="min-w-0" data-field={f.key}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="text-xs font-medium text-ink-2">
          {f.label}{required && <span className="ml-0.5 text-red-600">*</span>}
          {f.unit && f.type !== 'number' && f.type !== 'computed' ? <span className="ml-1 text-ink-3">({f.unit})</span> : null}
        </label>
        {narrative && (
          <NarrativeTools value={(value as string) ?? ''} onChange={onChange} field={f.key} formKey={formKey} patientId={patientId}
            encounterId={encounterId} dictation={f.dictation !== false} templates={f.templates !== false} copy={!!patientId && !!formKey} />
        )}
        {source && !isEmpty(value) && <span className="text-[10px] text-ink-3" title="Pre-filled">· from {source}</span>}
        {p.extra}
      </div>
      <FormControl {...p} />
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : f.help ? <p className="mt-1 text-xs text-ink-3">{f.help}</p> : null}
    </div>
  )
}

/** Multi-row grid for `lines` fields; supports computed and scored columns. */
export function FormLines({ f, value, onChange, disabled, errors, refs, patientId }: {
  f: FormField; value: Answers[] | null; onChange: (v: unknown) => void; disabled?: boolean; errors?: Record<string, string>; refs?: Record<string, string>; patientId?: string
}) {
  const rows = value ?? []
  const cols = f.fields ?? []
  const set = (i: number, k: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-surface-2 text-xs text-ink-2">
          <tr>
            <th className="w-8 px-2 py-1.5 text-left">#</th>
            {cols.map((c) => <th key={c.key} className="px-2 py-1.5 text-left font-medium">{c.label}{c.required && <span className="text-red-600">*</span>}</th>)}
            {!disabled && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              <td className="px-2 py-2 text-xs text-ink-3">{i + 1}</td>
              {cols.map((c) => (
                <td key={c.key} className="min-w-24 px-1 py-1">
                  {c.type === 'computed'
                    ? <div className="flex h-9 items-center px-2 font-semibold tabular text-ink">{isEmpty(r[c.key]) ? <span className="text-ink-3">—</span> : String(r[c.key])}</div>
                    : <FormControl f={c} value={r[c.key]} compact disabled={disabled} onChange={(v) => set(i, c.key, v)} refs={refs} patientId={patientId}
                        error={errors?.[`${f.key}.${i}.${c.key}`]} />}
                </td>
              ))}
              {!disabled && (
                <td className="px-1 py-1.5">
                  <button type="button" className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row">
                    <Trash2 className="size-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={cols.length + 2} className="px-3 py-3 text-center text-xs text-ink-3">No rows yet</td></tr>}
        </tbody>
      </table>
      {!disabled && (
        <button type="button" onClick={() => onChange([...rows, {}])}
          className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-xs font-medium text-brand-700 hover:bg-surface-2 dark:text-brand-300">
          <Plus className="size-3.5" /> Add row
        </button>
      )}
    </div>
  )
}

/** Read-only rendering of one answer (signed entries, print). */
export function AnswerValue({ f, value, refs }: { f: FormField; value: unknown; refs?: Record<string, string> }) {
  if (isEmpty(value)) return <span className="text-ink-3">—</span>
  if (f.type === 'signature' && typeof value === 'string') return <img src={value} alt="Signature" className="h-14 rounded border border-line bg-white" />
  if (f.type === 'lines' && Array.isArray(value)) {
    const cols = f.fields ?? []
    return (
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-ink-2"><tr>{cols.map((c) => <th key={c.key} className="px-2 py-1 text-left font-medium">{c.label}</th>)}</tr></thead>
          <tbody>{(value as Answers[]).map((r, i) => (
            <tr key={i} className="border-t border-line">{cols.map((c) => <td key={c.key} className="px-2 py-1">{formatAnswer(c, r[c.key], refs) || '—'}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    )
  }
  if (f.type === 'multiselect' && Array.isArray(value)) return <span className="flex flex-wrap gap-1">{value.map((v) => <Badge key={String(v)}>{String(v)}</Badge>)}</span>
  const score = f.type === 'choice' ? optionOf(f, value)?.score : itemScore(f, value)
  const text = formatAnswer(f, value, refs)
  return (
    <span className={cn('inline-flex items-start gap-2', f.type === 'textarea' && 'whitespace-pre-wrap')}>
      <span>{text}</span>
      {score !== undefined && score !== null && <span className="rounded bg-surface-2 px-1 text-[11px] tabular text-ink-3 ring-1 ring-line">{score}</span>}
    </span>
  )
}
