/**
 * Narrative helpers for any notes box: speech-to-text dictation (Web Speech API, en-IN), text templates
 * (personal · department · global), copy-from earlier entries and field history.
 *
 *   <DictationButton onText={(t) => setNote((n) => joinText(n, t))} />
 *   <TemplatePicker field="advice" onInsert={(t) => setNote((n) => joinText(n, t))} currentText={note} />
 *   <NarrativeTextarea label="Advice" value={note} onChange={setNote} field="advice" patientId={pid} />
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, FileText, History, Loader2, Mic, MicOff, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn, FieldWrap, Input, Modal, Popover, Select, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { fk } from './api'

/** Append text to existing narrative with a sensible separator. */
export function joinText(current: string | null | undefined, add: string): string {
  const cur = (current ?? '').replace(/\s+$/, '')
  if (!cur) return add.trim()
  const sep = /[.!?:;\n]$/.test(cur) ? (add.includes('\n') ? '\n' : ' ') : (add.includes('\n') ? '\n' : '. ')
  return cur + sep + add.trim()
}

// ------------------------------------------------------------------ dictation

interface SpeechResultLike { isFinal: boolean; 0: { transcript: string } }
interface SpeechEventLike { resultIndex: number; results: ArrayLike<SpeechResultLike> }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: SpeechEventLike) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const dictationSupported = () => recognitionCtor() !== null

/** Tidy a spoken phrase: spoken punctuation, capital first letter. */
function tidy(s: string): string {
  const t = s.replace(/\s+(full stop|period)\b/gi, '.').replace(/\s+comma\b/gi, ',').replace(/\s+new line\b/gi, '\n')
    .replace(/\s+question mark\b/gi, '?').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

export function useDictation(onText: (text: string) => void, lang = 'en-IN') {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const rec = useRef<Recognition | null>(null)
  const cb = useRef(onText)
  cb.current = onText
  useEffect(() => () => rec.current?.abort(), [])
  const stop = () => { rec.current?.stop(); setListening(false); setInterim('') }
  const start = () => {
    const Ctor = recognitionCtor()
    if (!Ctor) { toast.error('Dictation is not available in this browser — use Chrome or Edge, or type instead.'); return }
    const r = new Ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.onresult = (e) => {
      let partial = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) cb.current(tidy(res[0].transcript))
        else partial += res[0].transcript
      }
      setInterim(partial)
    }
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast.error('Microphone permission is blocked — allow it in the browser to dictate.')
      else if (e.error === 'network') toast.error('Dictation needs an internet connection.')
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast.error(`Dictation stopped: ${e.error}`)
    }
    r.onend = () => { setListening(false); setInterim('') }
    try { r.start(); rec.current = r; setListening(true) } catch { setListening(false) }
  }
  return { listening, interim, start, stop, supported: dictationSupported() }
}

export function DictationButton({ onText, lang = 'en-IN', size = 'xs', className, disabled }: {
  onText: (text: string) => void; lang?: string; size?: 'xs' | 'sm'; className?: string; disabled?: boolean
}) {
  const d = useDictation(onText, lang)
  const title = !d.supported ? 'Dictation is not supported in this browser (use Chrome or Edge)'
    : d.listening ? 'Stop dictation' : 'Dictate (speech to text, Indian English)'
  return (
    <span className={cn('relative inline-flex items-center', className)}>
      <button type="button" disabled={disabled || !d.supported} onClick={() => (d.listening ? d.stop() : d.start())} title={title} aria-pressed={d.listening}
        className={cn('inline-flex items-center gap-1 rounded-md font-medium ring-1 ring-inset transition-colors disabled:cursor-not-allowed disabled:opacity-40',
          size === 'xs' ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2 text-xs',
          d.listening ? 'bg-red-600 text-white ring-red-600 animate-pulse' : 'bg-surface text-red-700 ring-red-200 hover:bg-red-50 dark:text-red-300 dark:ring-red-500/30 dark:hover:bg-red-500/10')}>
        {d.listening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
        {d.listening ? 'Stop' : 'Dictate'}
      </button>
      {d.listening && d.interim && (
        <span className="absolute left-0 top-full z-30 mt-1 max-w-72 rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg">{d.interim}</span>
      )}
    </span>
  )
}

// ------------------------------------------------------------------ templates

export interface TextTemplate {
  id: string; code?: string; name: string; scope: 'Personal' | 'Department' | 'Global'; body: string; field_keys: string[]
  form_key?: string | null; shortcut?: string | null; department_name?: string | null; owner_name?: string | null; mine: boolean
}

const SCOPE_TONE = { Personal: 'violet', Department: 'blue', Global: 'green' } as const

export function TemplatePicker({ onInsert, formKey, field, currentText, size = 'xs', className, disabled }: {
  onInsert: (text: string) => void; formKey?: string; field?: string; currentText?: string | null; size?: 'xs' | 'sm'; className?: string; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const [saving, setSaving] = useState(false)
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: [...fk.templates(formKey, field), all],
    queryFn: () => api<{ rows: TextTemplate[] }>('/forms/templates', { query: { form_key: formKey, field, all } }),
    enabled: open, staleTime: 60_000,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/forms/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Template removed'); qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'templates'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return (list.data?.rows ?? []).filter((t) => !ql || t.name.toLowerCase().includes(ql) || (t.shortcut ?? '').toLowerCase().includes(ql) || t.body.toLowerCase().includes(ql))
  }, [list.data, q])
  return (
    <>
      <Popover open={open} onOpenChange={setOpen} align="left" className="w-[22rem] p-0"
        trigger={({ toggle }) => (
          <button type="button" disabled={disabled} onClick={toggle} title="Insert a text template"
            className={cn('inline-flex items-center gap-1 rounded-md bg-surface font-medium text-violet-700 ring-1 ring-inset ring-violet-200 hover:bg-violet-50 disabled:opacity-40 dark:text-violet-300 dark:ring-violet-500/30 dark:hover:bg-violet-500/10',
              size === 'xs' ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2 text-xs', className)}>
            <FileText className="size-3.5" /> Templates
          </button>
        )}>
        {(close) => (
          <div>
            <div className="border-b border-line p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
                <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" className="h-8 pl-8"
                  onKeyDown={(e) => { if (e.key === 'Enter' && rows[0]) { e.preventDefault(); onInsert(rows[0].body); close() } }} />
              </div>
              <label className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-2">
                <input type="checkbox" className="size-3.5 accent-brand-700" checked={all} onChange={(e) => setAll(e.target.checked)} />
                Show templates for every field
              </label>
            </div>
            <div className="max-h-72 overflow-y-auto py-1 scroll-thin">
              {list.isLoading && <div className="flex items-center gap-2 px-3 py-3 text-sm text-ink-3"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
              {list.error && <div className="px-3 py-2 text-sm text-red-600">{errorMessage(list.error)}</div>}
              {list.data && !rows.length && (
                <div className="px-3 py-4 text-center text-xs text-ink-3">No templates{field ? ' for this field' : ''} yet. Save the text you write as a template below.</div>
              )}
              {rows.map((t) => (
                <div key={t.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { onInsert(t.body); close() }}>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-ink">{t.name}</span>
                      <Badge tone={SCOPE_TONE[t.scope]}>{t.scope === 'Department' ? (t.department_name ?? 'Department') : t.scope}</Badge>
                    </span>
                    <span className="line-clamp-2 text-xs text-ink-2">{t.body}</span>
                  </button>
                  {t.mine && (
                    <button type="button" className="invisible rounded p-1 text-ink-3 hover:text-red-600 group-hover:visible" aria-label={`Remove ${t.name}`}
                      onClick={() => remove.mutate(t.id)}><Trash2 className="size-3.5" /></button>
                  )}
                </div>
              ))}
            </div>
            <div className="border-t border-line p-1">
              <button type="button" disabled={!currentText?.trim()} onClick={() => { setSaving(true); close() }}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-surface-2 disabled:text-ink-3 dark:text-brand-300">
                <Plus className="size-3.5" /> Save current text as a template
              </button>
            </div>
          </div>
        )}
      </Popover>
      {saving && <SaveTemplateModal body={currentText ?? ''} field={field} onClose={() => setSaving(false)} />}
    </>
  )
}

function SaveTemplateModal({ body, field, onClose }: { body: string; field?: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'Personal' | 'Department' | 'Global'>('Personal')
  const [onlyField, setOnlyField] = useState(!!field)
  const [text, setText] = useState(body)
  const save = useMutation({
    mutationFn: () => api('/forms/templates', { method: 'POST', body: { name, body: text, scope, field_keys: onlyField && field ? [field] : [], form_key: null } }),
    onSuccess: () => { toast.success('Template saved'); qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'templates'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Save as template" size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={name.trim().length < 2 || !text.trim()} onClick={() => save.mutate()}>Save template</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Name" required className="sm:col-span-2"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Normal systemic examination" /></FieldWrap>
        <FieldWrap label="Visible to" help={scope === 'Global' ? 'Everyone in the hospital' : scope === 'Department' ? 'Everyone in your department' : 'Only you'}>
          <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="Personal">Only me</option><option value="Department">My department</option><option value="Global">Whole hospital</option>
          </Select>
        </FieldWrap>
        {field && (
          <label className="mt-6 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="size-4 accent-brand-700" checked={onlyField} onChange={(e) => setOnlyField(e.target.checked)} />
            Offer only in “{field.replace(/_/g, ' ')}”
          </label>
        )}
        <FieldWrap label="Text" className="sm:col-span-2"><Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></FieldWrap>
        <p className="text-xs text-ink-3 sm:col-span-2">Do not put patient names or identifiers in templates.</p>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ copy-from / field history

export interface HistoryRow {
  entry_id: string; code?: string; form_key: string; form_title: string; field: string; field_label: string; value: unknown; text: string
  at?: string; by?: string; status: string; same_encounter: boolean
}

export function CopyFromMenu({ patientId, formKey, field, encounterId, onPick, mode = 'copy', size = 'xs', disabled }: {
  patientId: string; formKey: string; field: string; encounterId?: string; onPick: (text: string, value: unknown) => void
  mode?: 'copy' | 'history'; size?: 'xs' | 'sm'; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['x', 'emr', 'forms', 'field-history', patientId, formKey, field, encounterId ?? ''],
    queryFn: () => api<{ rows: HistoryRow[] }>('/forms/field-history', { query: { patient_id: patientId, form_key: formKey, field, encounter_id: encounterId } }),
    enabled: open, staleTime: 30_000,
  })
  return (
    <Popover open={open} onOpenChange={setOpen} align="left" className="w-[22rem] p-0"
      trigger={({ toggle }) => (
        <button type="button" disabled={disabled} onClick={toggle} title={mode === 'copy' ? 'Copy from an earlier entry' : 'Earlier values of this field'}
          className={cn('inline-flex items-center gap-1 rounded-md bg-surface font-medium text-ink-2 ring-1 ring-inset ring-line-2 hover:bg-surface-2 disabled:opacity-40',
            size === 'xs' ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2 text-xs')}>
          <History className="size-3.5" /> {mode === 'copy' ? <>Copy from <ChevronDown className="size-3" /></> : 'History'}
        </button>
      )}>
      {(close) => (
        <div className="max-h-80 overflow-y-auto py-1 scroll-thin">
          <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{mode === 'copy' ? 'Copy from' : 'Earlier values'}</div>
          {q.isLoading && <div className="flex items-center gap-2 px-3 py-3 text-sm text-ink-3"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
          {q.error && <div className="px-3 py-2 text-sm text-red-600">{errorMessage(q.error)}</div>}
          {q.data && !q.data.rows.length && <div className="px-3 py-4 text-center text-xs text-ink-3">Nothing recorded earlier for this patient.</div>}
          {q.data?.rows.map((r) => (
            <button key={`${r.entry_id}-${r.field}`} type="button" onClick={() => { onPick(r.text, r.value); close() }}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2">
              <span className="flex items-center justify-between gap-2 text-xs text-ink-3">
                <span className="truncate font-medium text-ink-2">{r.form_title}{r.field_label && r.form_key !== formKey ? ` · ${r.field_label}` : ''}</span>
                <span className="shrink-0">{dateTime(r.at)}</span>
              </span>
              <span className="line-clamp-3 whitespace-pre-wrap text-sm text-ink">{r.text}</span>
              <span className="text-[11px] text-ink-3">{r.by ?? '—'}{r.same_encounter ? ' · this admission' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

/** Field history (clock) for non-narrative fields — same data, picks the raw value. */
export function FieldHistoryButton(props: Omit<Parameters<typeof CopyFromMenu>[0], 'mode'>) {
  return <CopyFromMenu {...props} mode="history" />
}

// ------------------------------------------------------------------ composite

/** The three tools next to a notes box. Inserts at the end of the text (with a separator). */
export function NarrativeTools({ value, onChange, field, formKey, patientId, encounterId, dictation = true, templates = true, copy = true, disabled }: {
  value: string | null | undefined; onChange: (v: string) => void; field?: string; formKey?: string; patientId?: string; encounterId?: string
  dictation?: boolean; templates?: boolean; copy?: boolean; disabled?: boolean
}) {
  const latest = useRef(value)
  latest.current = value
  const add = (t: string) => onChange(joinText(latest.current, t))
  return (
    <span className="no-print inline-flex flex-wrap items-center gap-1">
      {copy && patientId && formKey && field && (
        <CopyFromMenu patientId={patientId} formKey={formKey} field={field} encounterId={encounterId} disabled={disabled}
          onPick={(t) => onChange(latest.current?.trim() ? joinText(latest.current, t) : t)} />
      )}
      {templates && <TemplatePicker onInsert={add} formKey={formKey} field={field} currentText={value} disabled={disabled} />}
      {dictation && <DictationButton onText={add} disabled={disabled} />}
    </span>
  )
}

/** Labelled textarea with Copy-from, Templates and Dictate — drop-in for any narrative field. */
export function NarrativeTextarea({ label, value, onChange, rows = 4, placeholder, required, error, help, field, formKey, patientId, encounterId, disabled, className, extra }: {
  label: ReactNode; value: string | null | undefined; onChange: (v: string) => void; rows?: number; placeholder?: string; required?: boolean
  error?: string; help?: ReactNode; field?: string; formKey?: string; patientId?: string; encounterId?: string; disabled?: boolean; className?: string; extra?: ReactNode
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-ink-2">{label}{required && <span className="ml-0.5 text-red-600">*</span>}</span>
        {!disabled && <NarrativeTools value={value} onChange={onChange} field={field} formKey={formKey} patientId={patientId} encounterId={encounterId} />}
        {extra}
      </div>
      <Textarea rows={rows} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} invalid={!!error} disabled={disabled} />
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : help ? <p className="mt-1 text-xs text-ink-3">{help}</p> : null}
    </div>
  )
}

export function SavedTick({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' | 'dirty' }) {
  if (state === 'saving') return <span className="inline-flex items-center gap-1 text-xs text-ink-3"><Loader2 className="size-3.5 animate-spin" /> Saving…</span>
  if (state === 'saved') return <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><Check className="size-3.5" /> Draft saved</span>
  if (state === 'dirty') return <span className="text-xs text-ink-3">Unsaved changes</span>
  if (state === 'error') return <span className="text-xs text-red-600">Not saved</span>
  return null
}
