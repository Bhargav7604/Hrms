import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Eraser, Eye, EyeOff, FileUp, Paperclip, Plus, Search, Star, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api, apiUrl, errorMessage, uploadFile } from '@/lib/api'
import { age, date, dateTime, money, number } from '@/lib/format'
import type { FieldDef, Rec } from '@/lib/types'
import { Badge, cn, CopyButton, Input, Select, StatusBadge, Textarea } from './ui'

/** Show only the last 4 characters (mobile numbers, ID numbers): 98480 12345 → ••••••2345 */
export function maskValue(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, '')
  if (!s) return ''
  return s.length <= 4 ? '•'.repeat(s.length) : `${'•'.repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`
}

/** A masked value with an eye toggle to reveal it (field configuration "mask"). */
export function MaskedValue({ value }: { value: unknown }) {
  const [show, setShow] = useState(false)
  return (
    <span className="inline-flex items-center gap-1">
      <span className="tabular">{show ? String(value) : maskValue(value)}</span>
      <button type="button" className="rounded p-0.5 text-ink-3 hover:text-ink" onClick={(e) => { e.stopPropagation(); setShow(!show) }}
        aria-label={show ? 'Hide' : 'Show full value'} title={show ? 'Hide' : 'Show full value'}>
        {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </span>
  )
}

// ------------------------------------------------------------------ helpers

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function filterQuery(filter?: Record<string, unknown>, extra?: Record<string, unknown>) {
  const q: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...(filter ?? {}), ...(extra ?? {}) })) {
    if (v !== undefined && v !== null && v !== '') q[`f_${k}`] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return q
}

const refPath = (ref: string) => `/lookup/${ref.replace('.', '/')}`

// ------------------------------------------------------------------ reference picker (combobox)

export interface RefPickerProps {
  refName: string
  value?: string | null
  onChange: (id: string | null, row?: Rec) => void
  label?: string
  filter?: Record<string, unknown>
  extraFilter?: Record<string, unknown>
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  kind?: string
  autoFocus?: boolean
}

export function RefPicker({ refName, value, onChange, label, filter, extraFilter, placeholder, disabled, invalid, kind, autoFocus }: RefPickerProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const box = useRef<HTMLDivElement>(null)
  const params = { q: dq, limit: 20, ...filterQuery(filter, extraFilter) }
  const list = useQuery({
    queryKey: ['lookup', refName, params],
    queryFn: () => api<Rec[]>(refPath(refName), { query: params }),
    enabled: open && !disabled,
    staleTime: 30_000,
  })
  const current = useQuery({
    queryKey: ['lookup-id', refName, value],
    queryFn: () => api<Rec[]>(refPath(refName), { query: { ids: value! } }),
    enabled: !!value && !label,
    staleTime: 5 * 60_000,
  })
  const shown = label ?? current.data?.[0]?.label ?? (value ? '…' : '')

  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={box} className="relative">
      {open ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? 'Type to search…'} className="pl-8"
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }} />
        </div>
      ) : (
        <button type="button" disabled={disabled} autoFocus={autoFocus}
          onClick={() => { setQ(''); setOpen(true) }}
          className={cn('flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-2 bg-surface px-3 text-left text-sm shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)]',
            'focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-surface-2', invalid && 'border-red-500')}>
          <span className={cn('truncate', !shown && 'text-ink-3')}>{shown || placeholder || 'Select…'}</span>
          <span className="flex items-center gap-1 text-ink-3">
            {value && !disabled && (
              <X className="size-4 hover:text-ink" onClick={(e) => { e.stopPropagation(); onChange(null) }} />
            )}
            <ChevronDown className="size-4" />
          </span>
        </button>
      )}
      {open && (
        <div className="absolute z-30 mt-1 max-h-72 w-full min-w-64 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
          {list.isLoading && <div className="px-3 py-2 text-sm text-ink-3">Searching…</div>}
          {list.error && <div className="px-3 py-2 text-sm text-red-600">{errorMessage(list.error)}</div>}
          {list.data?.length === 0 && <div className="px-3 py-2 text-sm text-ink-3">No matches</div>}
          {list.data?.map((r) => (
            <button type="button" key={r.id} onClick={() => { onChange(r.id, r); setOpen(false) }}
              className={cn('flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2', r.id === value && 'bg-brand-50 dark:bg-brand-500/10')}>
              <span className="min-w-0">
                <span className="block truncate text-ink">{r.title || r.label || r.code}</span>
                <span className="block truncate text-xs text-ink-3">{describeLookup(r, kind)}</span>
              </span>
              {r.id === value ? <Check className="mt-0.5 size-4 text-brand-700" /> : r.status ? <StatusBadge status={r.status} /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function describeLookup(r: Rec, kind?: string): string {
  if (kind === 'patient' || r.first_name !== undefined) {
    return [r.code, [age(r.dob), r.gender?.[0]].filter(Boolean).join('/'), r.phone].filter(Boolean).join(' · ')
  }
  if (r.category && r.designation) return [r.code, r.designation, r.category].filter(Boolean).join(' · ')
  if (r.rate !== undefined && r.rate !== null) return [r.code, r.category, money(r.rate)].filter(Boolean).join(' · ')
  if (r.bed_no) return [r.code, r.category].filter(Boolean).join(' · ')
  return [r.code, r.type ?? r.category ?? r.ward_type ?? r.dept_type].filter(Boolean).join(' · ')
}

// ------------------------------------------------------------------ signature pad

function SignaturePad({ value, onChange, disabled }: { value?: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    if (value) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0)
      img.src = value
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * ref.current!.width, ((e.clientY - r.top) / r.height) * ref.current!.height]
  }
  return (
    <div>
      <canvas ref={ref} width={560} height={160}
        className={cn('w-full touch-none rounded-lg border border-dashed border-line-2 bg-white', disabled && 'opacity-60')}
        onPointerDown={(e) => {
          if (disabled) return
          drawing.current = true
          const ctx = ref.current!.getContext('2d')!
          const [x, y] = pos(e)
          ctx.beginPath(); ctx.moveTo(x, y)
          ref.current!.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          const ctx = ref.current!.getContext('2d')!
          const [x, y] = pos(e)
          ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0f1720'
          ctx.lineTo(x, y); ctx.stroke()
          dirty.current = true
        }}
        onPointerUp={() => {
          drawing.current = false
          if (dirty.current) onChange(ref.current!.toDataURL('image/png'))
        }}
      />
      {!disabled && (
        <div className="mt-1 flex items-center justify-between text-xs text-ink-3">
          <span>Sign inside the box (finger, stylus or mouse)</span>
          <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => {
            const c = ref.current!; const ctx = c.getContext('2d')!
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); dirty.current = false; onChange(null)
          }}><Eraser className="size-3.5" /> Clear</button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ file upload

function FileInput({ value, onChange, patientId, disabled }: { value?: string | null; onChange: (v: string | null) => void; patientId?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const meta = useQuery({
    queryKey: ['file-meta', value],
    queryFn: () => api<{ name: string }>(`/files/${value}/meta`),
    enabled: !!value && !name,
  })
  const shown = name ?? meta.data?.name
  return (
    <div className="flex items-center gap-2">
      {value ? (
        <a href={apiUrl(`/files/${value}`, undefined, true)} target="_blank" rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-lg border border-line-2 px-3 py-1.5 text-sm text-brand-700 hover:bg-surface-2 dark:text-brand-300">
          <Paperclip className="size-4 shrink-0" /> <span className="truncate">{shown ?? 'View file'}</span>
        </a>
      ) : null}
      {!disabled && (
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-line-2 px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
          <FileUp className="size-4" /> {busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}
          <input type="file" className="sr-only" disabled={busy}
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xlsx,.dcm"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setBusy(true); setErr(null)
              try { const r = await uploadFile(f, patientId); setName(r.name); onChange(r.id) } catch (ex) { setErr(errorMessage(ex)) } finally { setBusy(false) }
            }} />
        </label>
      )}
      {value && !disabled && <button type="button" className="text-ink-3 hover:text-red-600" onClick={() => onChange(null)} aria-label="Remove file"><X className="size-4" /></button>}
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  )
}

// ------------------------------------------------------------------ tags

function TagsInput({ value, onChange, disabled }: { value?: string[] | null; onChange: (v: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState('')
  const tags = value ?? []
  const add = () => {
    const t = draft.trim().replace(/,$/, '')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line-2 bg-surface px-2 py-1">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-ink ring-1 ring-line">
          {t}
          {!disabled && <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}><X className="size-3" /></button>}
        </span>
      ))}
      {!disabled && (
        <input className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-ink-3" value={draft} placeholder={tags.length ? '' : 'Type and press Enter'}
          onChange={(e) => setDraft(e.target.value)} onBlur={add}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1)) }} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ lines (sub-table)

function LinesInput({ field, value, onChange, disabled, errors, refs }: {
  field: FieldDef; value?: Rec[] | null; onChange: (v: Rec[]) => void; disabled?: boolean; errors?: Record<string, string>; refs?: Record<string, string>
}) {
  const rows = value ?? []
  const cols = field.fields ?? []
  const set = (i: number, k: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[480px] text-sm">
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
              <td className="px-2 py-1.5 text-xs text-ink-3">{i + 1}</td>
              {cols.map((c) => (
                <td key={c.key} className="px-1 py-1">
                  <FieldInput field={{ ...c, width: 'full' }} value={r[c.key]} compact disabled={disabled}
                    onChange={(v) => set(i, c.key, v)} error={errors?.[`${field.key}.${i}.${c.key}`]} refs={refs} />
                </td>
              ))}
              {!disabled && (
                <td className="px-1 py-1.5">
                  <button type="button" className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove line">
                    <Trash2 className="size-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={cols.length + 2} className="px-3 py-3 text-center text-xs text-ink-3">No lines</td></tr>
          )}
        </tbody>
      </table>
      {!disabled && (
        <button type="button" onClick={() => onChange([...rows, {} as Rec])}
          className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-xs font-medium text-brand-700 hover:bg-surface-2 dark:text-brand-300">
          <Plus className="size-3.5" /> Add line
        </button>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ the field input switch

export interface FieldInputProps {
  field: FieldDef
  value: unknown
  onChange: (v: unknown) => void
  error?: string
  disabled?: boolean
  compact?: boolean
  refs?: Record<string, string>
  patientId?: string
  errors?: Record<string, string>
}

export function FieldInput({ field: f, value, onChange, error, disabled, compact, refs, patientId, errors }: FieldInputProps) {
  const invalid = !!error
  const v = value as never
  switch (f.type) {
    case 'textarea':
      return <Textarea rows={compact ? 1 : f.rows ?? 3} value={v ?? ''} disabled={disabled} invalid={invalid} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
    case 'number': case 'currency': case 'percent':
      return (
        <div className="relative">
          {f.type === 'currency' && <span className="pointer-events-none absolute left-3 top-2 text-sm text-ink-3">₹</span>}
          <Input type="number" inputMode="decimal" step={f.type === 'number' ? 'any' : '0.01'} min={f.min} max={f.max} value={v ?? ''} disabled={disabled} invalid={invalid}
            className={cn(f.type === 'currency' && 'pl-7', (f.unit || f.type === 'percent') && 'pr-12', 'tabular')} placeholder={f.placeholder}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
          {(f.unit || f.type === 'percent') && <span className="pointer-events-none absolute right-3 top-2 text-xs text-ink-3">{f.type === 'percent' ? '%' : f.unit}</span>}
        </div>
      )
    case 'date':
      return <Input type="date" value={v ?? ''} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />
    case 'datetime':
      return <Input type="datetime-local" value={v ? String(v).slice(0, 16) : ''} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />
    case 'time':
      return <Input type="time" value={v ?? ''} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />
    case 'select':
      return (
        <Select value={v ?? ''} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{compact ? '—' : 'Select…'}</option>
          {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      )
    case 'multiselect': {
      const cur: string[] = (v as string[] | null) ?? []
      return (
        <div className="flex flex-wrap gap-1.5">
          {f.options?.map((o) => {
            const on = cur.includes(o)
            return (
              <button type="button" key={o} disabled={disabled}
                onClick={() => onChange(on ? cur.filter((x) => x !== o) : [...cur, o])}
                className={cn('rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
                  on ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
                {o}
              </button>
            )
          })}
        </div>
      )
    }
    case 'tags':
      return <TagsInput value={v} onChange={onChange} disabled={disabled} />
    case 'boolean':
      return (
        <label className={cn('inline-flex h-9 cursor-pointer items-center gap-2 text-sm text-ink', disabled && 'opacity-60')}>
          <input type="checkbox" className="size-4 rounded border-line-2 accent-brand-700" checked={!!v} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          {compact ? '' : f.help ?? 'Yes'}
        </label>
      )
    case 'rating':
      return (
        <div className="flex h-9 items-center gap-0.5">
          {Array.from({ length: f.max ?? 5 }, (_, i) => i + 1).map((n) => (
            <button type="button" key={n} disabled={disabled} onClick={() => onChange(n)} aria-label={`${n} stars`}>
              <Star className={cn('size-5', Number(v) >= n ? 'fill-amber-400 text-amber-400' : 'text-line-2')} />
            </button>
          ))}
        </div>
      )
    case 'ref':
      return (
        <RefPicker refName={f.ref!} value={v} filter={f.filter} kind={f.kind} disabled={disabled} invalid={invalid}
          label={v ? refs?.[v] : undefined} onChange={(id) => onChange(id)}
          extraFilter={f.kind === 'encounter' && patientId ? { patient_id: patientId } : undefined} />
      )
    case 'lines':
      return <LinesInput field={f} value={v} onChange={onChange} disabled={disabled} errors={errors} refs={refs} />
    case 'signature':
      return <SignaturePad value={v} onChange={onChange} disabled={disabled} />
    case 'file':
      return <FileInput value={v} onChange={onChange} patientId={patientId} disabled={disabled} />
    case 'phone':
      return <Input type="tel" inputMode="tel" value={v ?? ''} disabled={disabled} invalid={invalid} placeholder={f.placeholder ?? '+91'} onChange={(e) => onChange(e.target.value)} />
    case 'email':
      return <Input type="email" value={v ?? ''} disabled={disabled} invalid={invalid} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
    default:
      return <Input value={v ?? ''} disabled={disabled} invalid={invalid} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
  }
}

// ------------------------------------------------------------------ read-only display

export function FieldValue({ field: f, value, refs, rec }: { field?: FieldDef; value: unknown; refs?: Record<string, string>; rec?: Rec }): ReactNode {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return <span className="text-ink-3">—</span>
  if (!f) return String(value)
  if (f.mask && (typeof value === 'string' || typeof value === 'number')) return <MaskedValue value={value} />
  const v = value as never
  switch (f.type) {
    case 'currency': return <span className="tabular">{money(v)}</span>
    case 'number': return <span className="tabular">{number(v)}{f.unit ? ` ${f.unit}` : ''}</span>
    case 'percent': return <span className="tabular">{number(v)}%</span>
    case 'date': return date(v)
    case 'datetime': return dateTime(v)
    case 'boolean': return v ? <Badge tone="green">Yes</Badge> : <span className="text-ink-3">No</span>
    case 'rating': return <span className="text-amber-500">{'★'.repeat(Number(v))}<span className="text-line-2">{'★'.repeat(Math.max(0, (f.max ?? 5) - Number(v)))}</span></span>
    case 'multiselect': case 'tags':
      return <span className="flex flex-wrap gap-1">{(v as string[]).map((t) => <Badge key={t} tone="gray">{t}</Badge>)}</span>
    case 'ref': {
      const label = refs?.[v] ?? '…'
      if (f.kind === 'patient') return <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/patients/${v}`}>{label}</Link>
      return label
    }
    case 'signature': return <img src={v} alt="Signature" className="h-16 rounded border border-line bg-white" />
    case 'file': return <FileInput value={v} onChange={() => {}} disabled />
    case 'lines': {
      const rows = v as Rec[]
      const cols = f.fields ?? []
      return (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="bg-surface-2 text-ink-2"><tr>{cols.map((c) => <th key={c.key} className="px-2 py-1 text-left font-medium">{c.label}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} className="border-t border-line">{cols.map((c) => <td key={c.key} className="px-2 py-1">{FieldValue({ field: c, value: r[c.key], refs, rec })}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )
    }
    case 'textarea': return <span className="whitespace-pre-wrap">{String(v)}</span>
    default: return String(v)
  }
}

/** Cell renderer for list columns (handles base columns too). */
export function Cell({ col, rec, fields, refs }: { col: string; rec: Rec; fields: Map<string, FieldDef>; refs: Record<string, string> }) {
  const v = rec[col]
  if (col === 'status') return <StatusBadge status={rec.status} />
  if (col === 'code') {
    return (
      <span className="group/code inline-flex items-center gap-0.5">
        <span className="font-mono text-xs text-ink-2">{rec.code}</span>
        <CopyButton value={rec.code} label="Copy code" className="opacity-0 group-hover/code:opacity-100 focus:opacity-100" />
      </span>
    )
  }
  if (col === 'title') return <span className="font-medium text-ink">{rec.title ?? '—'}</span>
  if (col === 'patient_id') return v ? <Link onClick={(e) => e.stopPropagation()} className="font-medium text-brand-700 hover:underline dark:text-brand-300" to={`/patients/${v}`}>{refs[v] ?? '…'}</Link> : <span className="text-ink-3">—</span>
  if (col === 'employee_id' || col === 'encounter_id') return v ? <span>{refs[v] ?? '…'}</span> : <span className="text-ink-3">—</span>
  if (col === 'created_at' || col === 'updated_at') return <span className="text-ink-2">{dateTime(v)}</span>
  const f = fields.get(col)
  // lists never show full mobile / ID numbers — open the record for the full value
  if (v && (f?.type === 'phone' || f?.mask)) return <span className="tabular text-ink-2" title="Open the record to see the full number">{maskValue(v)}</span>
  if (f?.type === 'ref' && f.kind === 'patient' && v) return <Link onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline dark:text-brand-300" to={`/patients/${v}`}>{refs[v] ?? '…'}</Link>
  if (f?.type === 'textarea' && typeof v === 'string') return <span className="line-clamp-1 max-w-xs">{v}</span>
  if (f?.type === 'lines') return <span className="text-ink-2">{(v as unknown[] | null)?.length ?? 0} lines</span>
  if (f?.type === 'signature') return v ? <Badge tone="green">Signed</Badge> : <span className="text-ink-3">—</span>
  return <>{FieldValue({ field: f, value: v, refs, rec })}</>
}

export function useFieldMap(fields: FieldDef[]) {
  return useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields])
}
