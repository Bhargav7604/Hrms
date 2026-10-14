/**
 * FormRunner — renders any clinical form definition: prefill, live score + risk band, conditional fields,
 * autosaved drafts, sign-off, amendment with reason, copy-previous / import, print and entry history.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useMyEmployeeId } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Modal, Popover, MenuItem, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { fk, useEntries, useEntry, useFormDef } from './api'
import { AnswerValue, FormFieldBlock, SPAN } from './fields'
import { IoFlowsheet } from './IoFlowsheet'
import { badgeTone, condOk, defaultsFor, evaluate, formatAnswer, isEmpty, missingRequired, SECTION_TINT, TONE_RING, type Evaluation } from './logic'
import { SavedTick } from './narrative'
import type { Answers, Entry, FormContext, FormDef, Section } from './types'

export interface FormRunnerProps extends FormContext {
  formKey: string
  recordId?: string
  onSaved?: (id: string) => void
  onClose?: () => void
  /** OT booking the entry belongs to (OT booklet sheets). */
  bookingId?: string
  /** Render signed / view-only even when the role could edit. */
  readOnly?: boolean
  /** Called after a successful sign or amendment. */
  onSigned?: (entry: Entry) => void
  /** Content rendered above the form (e.g. the OT booklet navigator). */
  header?: ReactNode
  /** Hide the entry-history card under the form. */
  hideHistory?: boolean
}

export function FormRunner(props: FormRunnerProps) {
  const def = useFormDef(props.formKey)
  const [opened, setOpened] = useState<string | undefined>(props.recordId)
  // an id this runner created itself must not remount the open form when the parent echoes it back
  const created = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (props.recordId && props.recordId === created.current) return
    setOpened(props.recordId)
  }, [props.recordId, props.formKey])
  const onSaved = useCallback((id: string) => { created.current = id; props.onSaved?.(id) }, [props.onSaved])
  if (def.isLoading) return <Spinner label="Opening form…" />
  if (def.error) return <ErrorBox error={def.error} />
  const d = def.data!
  if (d.component === 'io_flowsheet') return <IoFlowsheet patientId={props.patientId} encounterId={props.encounterId} />
  return (
    <div className="space-y-3">
      {props.header}
      <RunnerBody key={`${d.key}:${opened ?? 'new'}`} {...props} onSaved={onSaved} def={d} recordId={opened}
        onOpen={(id) => { created.current = undefined; setOpened(id) }} />
      {!props.hideHistory && <EntryHistory def={d} patientId={props.patientId} encounterId={props.encounterId} current={opened} onOpen={setOpened} />}
    </div>
  )
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
type Mode = 'edit' | 'view' | 'amend'

function RunnerBody({ def, patientId, encounterId, recordId, bookingId, readOnly, onSaved, onClose, onSigned, onOpen }: FormRunnerProps & { def: FormDef; onOpen: (id?: string) => void }) {
  const qc = useQueryClient()
  const me = useMyEmployeeId()
  const { user } = useAuth()
  const access = def.access
  const [entryId, setEntryId] = useState<string | undefined>(recordId)
  const entryQ = useEntry(entryId)
  const prefillQ = useQuery({
    queryKey: ['forms-prefill', def.key, patientId, encounterId ?? '', bookingId ?? ''],
    queryFn: () => api<{ answers: Answers; sources: Record<string, string> }>('/forms/prefill', {
      query: { form_key: def.key, patient_id: patientId, encounter_id: encounterId, booking_id: bookingId } }),
    enabled: !recordId && access.fill, staleTime: 0,
  })
  const [answers, setAnswers] = useState<Answers | null>(null)
  const [server, setServer] = useState<Entry | null>(null)
  const [mode, setMode] = useState<Mode>('edit')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflictMsg, setConflictMsg] = useState<string | null>(null)
  const [confirmSign, setConfirmSign] = useState(false)
  const [amendOpen, setAmendOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => Object.fromEntries(def.sections.map((s) => [s.key, !!s.collapsed])))
  const touched = useRef(false)
  const version = useRef(0)
  const saving = useRef(false)
  const answersRef = useRef<Answers | null>(null)
  answersRef.current = answers
  const serverRef = useRef<Entry | null>(null)
  serverRef.current = server
  const root = useRef<HTMLDivElement>(null)

  // ---- initial answers (existing entry, or defaults + prefill)
  useEffect(() => {
    if (answers) return
    if (entryId && entryQ.data) {
      setServer(entryQ.data)
      setAnswers(entryQ.data.answers ?? {})
      setMode(entryQ.data.status === 'Draft' && access.fill && !readOnly ? 'edit' : 'view')
    } else if (!entryId && (prefillQ.data || prefillQ.error || !access.fill)) {
      setAnswers({ ...defaultsFor(def, me), ...(prefillQ.data?.answers ?? {}) })
      setMode(access.fill && !readOnly ? 'edit' : 'view')
    }
  }, [answers, entryId, entryQ.data, prefillQ.data, prefillQ.error, def, me, access.fill, readOnly])

  const ev: Evaluation | null = useMemo(() => (answers ? evaluate(def, answers) : null), [def, answers])
  const values = ev?.values ?? {}
  const editable = (mode === 'edit' && access.fill) || mode === 'amend'
  const refs = server?.refs ?? {}

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: fk.all })
    qc.invalidateQueries({ queryKey: ['patient', patientId] })
  }, [qc, patientId])

  const set = (key: string, v: unknown) => {
    touched.current = true
    version.current += 1
    setAnswers((a) => ({ ...(a ?? {}), [key]: v }))
    setSaveState('dirty')
    if (errors[key]) setErrors((e) => { const n = { ...e }; delete n[key]; return n })
  }

  const payload = () => {
    const a = { ...(answersRef.current ?? {}) }
    for (const s of def.sections) for (const f of s.fields) if (f.type === 'computed' || f.type === 'info') delete a[f.key]
    return a
  }

  // ---- autosave drafts
  const saveDraft = useCallback(async (): Promise<Entry | null> => {
    if (saving.current || mode !== 'edit' || !access.fill) return null
    saving.current = true
    const v = version.current
    setSaveState('saving')
    try {
      const id = serverRef.current?.id ?? entryId
      const res = id
        ? await api<Entry>(`/forms/entries/${id}`, { method: 'PUT', body: { answers: payload(), base_updated_at: serverRef.current?.updated_at } })
        : await api<Entry>('/forms/entries', { method: 'POST', body: { form_key: def.key, patient_id: patientId, encounter_id: encounterId, ot_booking: bookingId, answers: payload() } })
      setServer(res)
      if (!id) { setEntryId(res.id); onSaved?.(res.id) }
      if (version.current === v) setSaveState('saved')
      else setSaveState('dirty')
      qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'defs'] })
      return res
    } catch (e) {
      setSaveState('error')
      if (e instanceof ApiError && e.status === 409) {
        const existing = (e.details as { entry_id?: string } | undefined)?.entry_id
        if (existing) { toast.info(e.message); onOpen(existing); return null }
        setConflictMsg(e.message)
      } else if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors)
      else toast.error(errorMessage(e))
      return null
    } finally {
      saving.current = false
    }
  }, [mode, access.fill, entryId, def.key, patientId, encounterId, bookingId, onSaved, onOpen, qc])

  useEffect(() => {
    if (saveState !== 'dirty' || !touched.current || mode !== 'edit' || conflictMsg) return
    const t = window.setTimeout(() => { void saveDraft() }, 1200)
    return () => window.clearTimeout(t)
  }, [answers, saveState, mode, saveDraft, conflictMsg])

  // ---- sign / amend
  const firstError = (errs: Record<string, string>) => {
    const k = Object.keys(errs)[0]?.split('.')[0]
    const sec = def.sections.find((s) => s.fields.some((f) => f.key === k))
    if (sec) setCollapsed((c) => ({ ...c, [sec.key]: false }))
    window.setTimeout(() => root.current?.querySelector(`[data-field="${k}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }
  const startSign = () => {
    const miss = missingRequired(def, values)
    if (Object.keys(miss).length) {
      setErrors(miss)
      toast.error(`Complete ${Object.keys(miss).length} required field${Object.keys(miss).length > 1 ? 's' : ''} before signing`)
      firstError(miss)
      return
    }
    setConfirmSign(true)
  }
  const sign = async () => {
    setBusy(true)
    try {
      const id = serverRef.current?.id ?? entryId
      const res = id
        ? await api<Entry>(`/forms/entries/${id}/sign`, { method: 'POST', body: { answers: payload(), base_updated_at: serverRef.current?.updated_at } })
        : await api<Entry>('/forms/entries', { method: 'POST', body: { form_key: def.key, patient_id: patientId, encounter_id: encounterId, ot_booking: bookingId, answers: payload(), sign: true } })
      afterSigned(res, 'signed')
      if (!id) { setEntryId(res.id); onSaved?.(res.id) }
    } catch (e) {
      handleErr(e)
    } finally { setBusy(false); setConfirmSign(false) }
  }
  const amend = async (reason: string) => {
    setBusy(true)
    try {
      const res = await api<Entry>(`/forms/entries/${server!.id}/amend`, { method: 'POST', body: { answers: payload(), reason, base_updated_at: server!.updated_at } })
      afterSigned(res, 'amended')
      setAmendOpen(false)
    } catch (e) { handleErr(e) } finally { setBusy(false) }
  }
  const afterSigned = (res: Entry, what: string) => {
    setServer(res)
    setAnswers(res.answers)
    setMode('view')
    setSaveState('idle')
    setErrors({})
    touched.current = false
    invalidate()
    toast.success(`${def.short ?? def.title} ${what}${res.score !== null && res.score !== undefined ? ` · ${res.score_label} ${res.score}` : ''}${res.risk_band ? ` (${res.risk_band})` : ''}`)
    if (res.linked?.['nursing.tasks']) toast.info('A nursing task was created for this risk')
    for (const n of res.effect_notes ?? []) toast.message(n)
    onSigned?.(res)
  }
  const handleErr = (e: unknown) => {
    if (e instanceof ApiError && Object.keys(e.fieldErrors).length) { setErrors(e.fieldErrors); firstError(e.fieldErrors) }
    if (e instanceof ApiError && e.status === 409) setConflictMsg(e.message)
    toast.error(errorMessage(e))
  }
  const discard = async () => {
    const id = server?.id ?? entryId
    if (!id || !window.confirm('Discard this draft? It will be removed from the record.')) return
    try {
      await api(`/forms/entries/${id}`, { method: 'DELETE' })
      toast.success('Draft discarded')
      invalidate()
      onOpen(undefined)
      onClose?.()
    } catch (e) { toast.error(errorMessage(e)) }
  }
  const reload = async () => {
    const id = server?.id ?? entryId
    setConflictMsg(null)
    if (!id) return
    const res = await qc.fetchQuery({ queryKey: fk.entry(id), queryFn: () => api<Entry>(`/forms/entries/${id}`), staleTime: 0 })
    setServer(res); setAnswers(res.answers); setSaveState('idle'); touched.current = false
    setMode(res.status === 'Draft' && access.fill ? 'edit' : 'view')
  }
  const copyPrevious = async () => {
    try {
      const prev = await api<{ rows: { id: string; status: string }[] }>('/forms/entries', { query: { patient_id: patientId, form_key: def.key, status: 'Signed,Amended', limit: 5 } })
      const src = prev.rows.find((r) => r.id !== (server?.id ?? entryId))
      if (!src) { toast.info('No earlier signed entry of this form for the patient'); return }
      const e = await api<Entry>(`/forms/entries/${src.id}`)
      const skip = new Set(['noted_at', 'signature'])
      const copied: Answers = {}
      for (const s of def.sections) for (const f of s.fields) {
        if (skip.has(f.key) || f.type === 'signature' || f.type === 'datetime' || f.type === 'computed') continue
        if (!isEmpty(e.answers[f.key])) copied[f.key] = e.answers[f.key]
      }
      touched.current = true; version.current += 1
      setAnswers((a) => ({ ...(a ?? {}), ...copied }))
      setSaveState('dirty')
      toast.success(`Copied ${Object.keys(copied).length} answers from ${e.code} (${dateTime(e.noted_at)}) — review before signing`)
    } catch (e) { toast.error(errorMessage(e)) }
  }
  const importFrom = async () => {
    try {
      const r = await api<{ sources: { label: string; answers: Answers; entry: { code?: string; noted_at?: string } | null }[] }>('/forms/import', { query: { form_key: def.key, patient_id: patientId, encounter_id: encounterId } })
      const src = r.sources.find((s) => s.entry)
      if (!src) { toast.info(`Nothing to import — ${r.sources[0]?.label ?? 'the source form'} is not signed yet`); return }
      const cur = answersRef.current ?? {}
      const filled = Object.fromEntries(Object.entries(src.answers).filter(([k]) => isEmpty(cur[k])))
      const skipped = Object.keys(src.answers).length - Object.keys(filled).length
      touched.current = true; version.current += 1
      setAnswers((a) => ({ ...(a ?? {}), ...filled }))
      setSaveState('dirty')
      toast.success(`Imported ${Object.keys(filled).length} sections from ${src.label} ${src.entry?.code ?? ''}${skipped ? ` (${skipped} already written were kept)` : ''}`)
    } catch (e) { toast.error(errorMessage(e)) }
  }

  // ---- keyboard: Ctrl/Cmd+S saves, Ctrl/Cmd+Enter signs
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !root.current?.contains(document.activeElement)) return
      if (e.key === 's' && mode === 'edit') { e.preventDefault(); void saveDraft() }
      if (e.key === 'Enter' && access.sign && mode !== 'view') { e.preventDefault(); if (mode === 'amend') setAmendOpen(true); else startSign() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  if ((entryId && entryQ.isLoading) || !answers) return <Card><Spinner label="Loading form…" /></Card>
  if (entryQ.error) return <ErrorBox error={entryQ.error} />
  if (!entryId && !access.fill) {
    return (
      <Card>
        <Empty icon="Eye" title={`${def.title} — view only`}>Your role can read signed {def.short ?? 'entries'} but cannot start a new one. Earlier entries are listed below.</Empty>
      </Card>
    )
  }
  const status = server?.status ?? 'New'
  const sources = prefillQ.data?.sources ?? {}

  return (
    <div ref={root} className="space-y-3">
      <Card pad={false}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-300">
              <Icon name={def.icon ?? 'ClipboardList'} className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-ink">{def.title}</h2>
                {status === 'New' ? <Badge tone="gray">New</Badge> : <StatusBadge status={status} />}
                {server?.code && <span className="font-mono text-xs text-ink-3">{server.code}</span>}
                {def.one_per_admission && <Badge tone="violet">One per admission</Badge>}
                {mode === 'amend' && <Badge tone="amber" dot>Amending</Badge>}
                {!access.fill && !access.sign && <Badge tone="gray">View only</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-ink-2">{def.description}</p>
              {server && server.status !== 'Draft' && (
                <p className="mt-0.5 text-xs text-ink-3">Signed by {server.signed_by_name ?? '—'} · {dateTime(server.signed_at)}
                  {server.amended_at && <> · amended {dateTime(server.amended_at)}</>}</p>
              )}
              {server?.status === 'Draft' && <p className="mt-0.5 text-xs text-ink-3">Draft by {server.author_name ?? server.last_edited_by ?? '—'} · updated {ago(server.updated_at)}</p>}
            </div>
          </div>
          <div className="no-print flex flex-wrap items-center gap-2">
            {mode === 'edit' && <SavedTick state={saveState} />}
            {editable && (
              <Popover align="right" trigger={({ toggle }) => <Button size="sm" variant="secondary" icon="Wand2" onClick={toggle}>Fill <ChevronDown className="size-3.5" /></Button>}>
                {(close) => (
                  <>
                    <MenuItem icon="CopyPlus" onClick={() => { close(); void copyPrevious() }}>Copy from previous entry</MenuItem>
                    {def.import_from.map((i) => (
                      <MenuItem key={i.form} icon="Import" onClick={() => { close(); void importFrom() }}>Import from {i.label ?? i.form}</MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}
            {mode === 'edit' && server?.id && (
              <Button size="sm" variant="ghost" icon="RotateCcw" onClick={() => void reload()} title="Discard unsaved changes">Reset</Button>
            )}
            {server?.id && <Button size="sm" variant="secondary" icon="Printer" onClick={() => window.open(`/print/forms/${server.id}`, '_blank')}>Print</Button>}
            {mode === 'edit' && server?.status === 'Draft' && (access.fill || access.sign) && (
              <Button size="sm" variant="ghost" icon="Trash2" onClick={() => void discard()}>Discard</Button>
            )}
            {mode === 'view' && server && server.status !== 'Draft' && access.sign && !readOnly && (
              <Button size="sm" variant="secondary" icon="PencilLine" onClick={() => setMode('amend')}>Amend</Button>
            )}
            {mode === 'view' && server?.status === 'Draft' && access.fill && !readOnly && (
              <Button size="sm" variant="secondary" icon="Pencil" onClick={() => setMode('edit')}>Continue draft</Button>
            )}
            {mode === 'amend' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => void reload()}>Cancel</Button>
                <Button size="sm" variant="warning" icon="Save" onClick={() => setAmendOpen(true)}>Save amendment</Button>
              </>
            )}
            {mode === 'edit' && access.sign && (
              <Button size="sm" variant="primary" icon="PenLine" loading={busy} onClick={startSign} title="Sign (Ctrl+Enter)">Sign</Button>
            )}
            {mode === 'edit' && !access.sign && access.fill && (
              <Button size="sm" variant="primary" icon="Save" onClick={() => void saveDraft()}>Save draft</Button>
            )}
            {onClose && <Button size="sm" variant="ghost" icon="X" onClick={onClose} aria-label="Close form" />}
          </div>
        </div>
        {conflictMsg && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <span>{conflictMsg}</span>
            <Button size="xs" onClick={() => void reload()}>Reload latest</Button>
          </div>
        )}
        {mode === 'edit' && !access.sign && access.fill && (
          <div className="border-t border-line px-4 py-1.5 text-xs text-ink-3">Your role fills this form; a {def.sign_roles.join(' / ')} signs it.</div>
        )}
      </Card>

      {def.score && ev && <ScoreBar def={def} ev={ev} />}

      {server?.effect_notes && server.effect_notes.length > 0 && mode === 'view' && (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          {server.effect_notes.map((n) => <div key={n}>• {n}</div>)}
        </div>
      )}

      {def.sections.map((s, i) => condOk(s.show_if, values) && (
        <SectionCard key={s.key} no={i + 1} section={s} collapsed={!!collapsed[s.key]} onToggle={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
          values={values} errors={errors}>
          {editable ? (
            <div className="grid grid-cols-12 gap-x-4 gap-y-3">
              {s.fields.map((f) => condOk(f.show_if, values) && (
                <div key={f.key} className={SPAN[f.width ?? 'quarter']}>
                  <FormFieldBlock f={f} value={values[f.key]} onChange={(v) => set(f.key, v)} error={errors[f.key]} errors={errors} refs={refs}
                    patientId={patientId} encounterId={encounterId} formKey={def.key}
                    required={f.required || (f.required_if ? condOk(f.required_if, values) : false)} source={sources[f.key]} />
                </div>
              ))}
            </div>
          ) : (
            <dl className="grid grid-cols-12 gap-x-4 gap-y-2.5">
              {s.fields.map((f) => condOk(f.show_if, values) && f.type !== 'info' && (
                <div key={f.key} className={SPAN[f.type === 'textarea' || f.type === 'lines' || f.type === 'choice' ? (f.width === 'full' || f.type === 'lines' ? 'full' : 'half') : f.width ?? 'quarter']}>
                  <dt className="text-xs font-medium text-ink-3">{f.label}</dt>
                  <dd className="mt-0.5 break-words text-sm text-ink"><AnswerValue f={f} value={values[f.key]} refs={refs} /></dd>
                </div>
              ))}
            </dl>
          )}
        </SectionCard>
      ))}

      {server && server.amendments.length > 0 && <Amendments def={def} entry={server} />}

      {confirmSign && ev && (
        <Modal open onClose={() => setConfirmSign(false)} title={`Sign ${def.short ?? def.title}?`} size="sm"
          footer={<><Button variant="ghost" onClick={() => setConfirmSign(false)}>Back</Button><Button variant="primary" icon="PenLine" loading={busy} onClick={() => void sign()}>Sign as {user?.name}</Button></>}>
          <div className="space-y-2 text-sm text-ink-2">
            {def.score && ev.score !== null && (
              <div className={cn('rounded-lg border px-3 py-2', TONE_RING[ev.band?.tone ?? 'gray'])}>
                <div className="font-semibold">{def.score.label} {ev.score}{def.score.unit ? ` ${def.score.unit}` : ''} · {ev.band?.label ?? '—'}</div>
                {ev.band?.task && <div className="mt-1 text-xs">Signing creates a {ev.band.task.priority} nursing task: {ev.band.task.text}</div>}
              </div>
            )}
            <p>Signed forms become part of the legal medical record. Later changes are made as amendments with a reason and are audited.</p>
            {def.mirror.length > 0 && <p className="text-xs text-ink-3">Also posts to: {def.mirror.map((m) => MIRROR_LABEL[m] ?? m).join(', ')}.</p>}
          </div>
        </Modal>
      )}
      {amendOpen && <AmendModal def={def} before={server?.answers ?? {}} after={values} busy={busy} onClose={() => setAmendOpen(false)} onSave={(r) => void amend(r)} />}
    </div>
  )
}

const MIRROR_LABEL: Record<string, string> = {
  vitals: 'Vitals chart (NEWS2)', incident: 'Patient Safety incidents (when applicable)', bundle: 'Infection Surveillance bundle audits',
  who_checklist: 'OT surgical safety checklist (needs an OT booking)',
}

function SectionCard({ section: s, no, collapsed, onToggle, values, errors, children }: {
  section: Section; no: number; collapsed: boolean; onToggle: () => void; values: Answers; errors: Record<string, string>; children: ReactNode
}) {
  const visible = s.fields.filter((f) => f.type !== 'info' && f.type !== 'computed' && condOk(f.show_if, values))
  const filled = visible.filter((f) => !isEmpty(values[f.key])).length
  const errs = s.fields.filter((f) => errors[f.key]).length
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed}
        className={cn('flex w-full items-center gap-2 px-4 py-2 text-left', SECTION_TINT[s.tone ?? 'gray'])}>
        {collapsed ? <ChevronRight className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
        <span className="text-sm font-semibold">{/^\d+\./.test(s.title) ? s.title : `${no}. ${s.title}`}</span>
        {s.description && <span className="hidden truncate text-xs opacity-75 sm:inline">{s.description}</span>}
        <span className="ml-auto flex items-center gap-2 text-xs opacity-80">
          {errs > 0 && <Badge tone="red">{errs} to fix</Badge>}
          <span className="tabular">{filled}/{visible.length}</span>
        </span>
      </button>
      {!collapsed && <div className="px-4 py-3">{children}</div>}
    </section>
  )
}

export function ScoreBar({ def, ev }: { def: FormDef; ev: Evaluation }) {
  const sc = def.score!
  const band = ev.complete ? ev.band : null
  const tone = band?.tone ?? 'gray'
  const isPct = sc.method === 'percent_yes'
  return (
    <div className={cn('sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 shadow-sm', TONE_RING[tone])} aria-live="polite">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-medium opacity-80">{sc.label}</span>
        <span className="text-2xl font-semibold tabular">{ev.score === null ? '—' : isPct ? Math.round(ev.score) : ev.score}</span>
        <span className="text-xs opacity-70">{isPct ? '%' : sc.max !== undefined && sc.max !== null ? `/ ${sc.max}` : sc.unit ?? ''}</span>
      </div>
      {band ? <Badge tone={badgeTone(band.tone)} dot>{band.label}</Badge>
        : <Badge tone="gray">{ev.answered ? `Partial — ${ev.answered} of ${ev.total} answered` : 'Not scored yet'}</Badge>}
      {ev.counts && <span className="text-xs opacity-80">{ev.counts.yes} met · {ev.counts.no} not met · {ev.counts.na} N/A</span>}
      {band?.action && <span className="min-w-0 flex-1 basis-80 text-xs leading-snug">{band.action}</span>}
      {band?.reassess_hours && <span className="text-xs opacity-80">Reassess in {band.reassess_hours >= 1 ? `${band.reassess_hours} h` : `${Math.round(band.reassess_hours * 60)} min`}</span>}
      {band?.task && <Badge tone={band.task.priority === 'STAT' ? 'red' : 'amber'}>Task on sign · {band.task.priority}</Badge>}
      {sc.lower_is_worse && <span className="text-[11px] opacity-70">Lower score = higher risk</span>}
    </div>
  )
}

function AmendModal({ def, before, after, busy, onClose, onSave }: { def: FormDef; before: Answers; after: Answers; busy: boolean; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  const fields = def.sections.flatMap((s) => s.fields).filter((f) => f.type !== 'computed' && f.type !== 'info')
  const changed = fields.filter((f) => JSON.stringify(before[f.key] ?? null) !== JSON.stringify(after[f.key] ?? null))
  return (
    <Modal open onClose={onClose} title="Amend signed form" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="warning" loading={busy} disabled={reason.trim().length < 5 || !changed.length} onClick={() => onSave(reason.trim())}>Save amendment</Button></>}>
      <div className="space-y-3">
        {changed.length ? (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-1.5 text-left">Field</th><th className="px-3 py-1.5 text-left">Before</th><th className="px-3 py-1.5 text-left">After</th></tr></thead>
              <tbody>{changed.map((f) => (
                <tr key={f.key} className="border-t border-line align-top">
                  <td className="px-3 py-1.5 font-medium text-ink">{f.label}</td>
                  <td className="px-3 py-1.5 text-ink-2 line-through decoration-red-400">{formatAnswer(f, before[f.key]) || '—'}</td>
                  <td className="px-3 py-1.5 text-ink">{formatAnswer(f, after[f.key]) || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="text-sm text-ink-2">Nothing has changed yet — edit the answers first.</p>}
        <FieldWrap label="Reason for amendment" required help="Recorded with your name and time in the amendment history and audit trail.">
          <Textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Corrected after clarification with the patient's daughter" />
        </FieldWrap>
      </div>
    </Modal>
  )
}

function Amendments({ def, entry }: { def: FormDef; entry: Entry }) {
  const fmap = new Map(def.sections.flatMap((s) => s.fields.map((f) => [f.key, f] as const)))
  return (
    <Card title="Amendment history" icon="History">
      <ol className="space-y-3">
        {[...entry.amendments].reverse().map((a, i) => (
          <li key={i} className="border-l-2 border-amber-400 pl-3">
            <div className="text-sm font-medium text-ink">{a.by_name ?? '—'} · {dateTime(a.at)}</div>
            <div className="text-sm text-ink-2">Reason: {a.reason}</div>
            <div className="mt-1 text-xs text-ink-3">Changed: {a.fields.map((k) => fmap.get(k)?.label ?? k).join(', ')}
              {a.score_before !== a.score_after && <> · score {a.score_before ?? '—'} → {a.score_after ?? '—'}</>}
              {a.band_before !== a.band_after && <> · {a.band_before ?? '—'} → {a.band_after ?? '—'}</>}</div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function EntryHistory({ def, patientId, encounterId, current, onOpen }: { def: FormDef; patientId: string; encounterId?: string; current?: string; onOpen: (id?: string) => void }) {
  const q = useEntries({ patient_id: patientId, form_key: def.key, limit: 20 })
  const rows = q.data?.rows ?? []
  if (!rows.length) return null
  return (
    <Card title={`Earlier ${def.short ?? def.title} entries`} icon="History" pad={false}
      actions={current && def.access.fill && !def.one_per_admission ? <Button size="xs" icon="Plus" onClick={() => onOpen(undefined)}>New entry</Button> : undefined}>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r.id)}
              className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left text-sm hover:bg-surface-2', r.id === current && 'bg-brand-50 dark:bg-brand-500/10')}>
              <span className="w-36 shrink-0 text-xs text-ink-2">{dateTime(r.noted_at)}</span>
              <StatusBadge status={r.status} />
              {r.score !== null && r.score !== undefined && <Badge tone={badgeTone(r.risk_tone)}>{r.score_label} {r.score}{r.risk_band ? ` · ${r.risk_band}` : ''}</Badge>}
              <span className="min-w-0 flex-1 truncate text-ink-2">{r.summary}</span>
              <span className="text-xs text-ink-3">{r.signed_by_name ?? r.author_name}{encounterId && r.encounter_id !== encounterId ? ' · earlier visit' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
