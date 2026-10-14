import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity, AlertTriangle, ClipboardList, FileText, FlaskConical, FolderOpen, History, LineChart as LineIcon, Link2, Pencil, Plus, Sparkles, Trash2, Zap,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Lines } from '@/components/charts'
import { RefPicker, useDebounced } from '@/components/fields'
import {
  Badge, Button, Card, cn, Drawer, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Select, Spinner, Textarea, type BadgeTone,
} from '@/components/ui'
import { FormRunner, NarrativeTools } from '@/features/forms'
import { ApiError, api, apiUrl, errorMessage, uploadFile } from '@/lib/api'
import { dateTime, money, time } from '@/lib/format'
import type { Rec } from '@/lib/types'
import { useScreenConfig } from '@/features/registration/api'

interface RxItem { drug?: string | null; drug_name?: string | null; name?: string | null; dose?: string | null; route?: string | null; frequency?: string | null; duration_days?: number | null; qty?: number | null; instructions?: string | null; strength?: string | null; high_alert?: boolean }
interface Emr {
  encounter: { id: string; code: string; type: string; status: string; started_at?: string; ended_at?: string; doctor?: string; doctor_id?: string; department?: string; department_id?: string }
  appointment: Rec | null
  patient: Rec
  consultation: Rec | null
  note_format: string
  department_format: string
  note_formats: { key: string; label: string }[]
  prescription: { id: string; code: string; status: string; notes?: string; items: RxItem[] } | null
  orders: { id: string; code: string; status: string; category: string; priority: string; test: string; ordered_at: string; critical: boolean }[]
  vitals: { latest: Rec | null; series: Rec[] }
  assessment: Rec | null
  allergies: { allergen: string; severity?: string; reaction?: string }[]
  problems: { id: string; problem: string; icd_code?: string }[]
  active_meds: { item_id: string; name: string; dose?: string; frequency?: string }[]
  history: { id: string; date: string; doctor?: string; department?: string; chief_complaint?: string; diagnosis?: string; medicines: number; encounter_id?: string; follow_up?: string }[]
  documents: { id: string; name: string; mime?: string; size?: number; created_at?: string }[]
  ai_summary: { id: string; code: string; status: string; content: string; source?: string; created_at?: string } | null
  can_edit: boolean
  can_prescribe: boolean
}
interface Alert { severity: string; message: string; type?: string }
interface Drug { id: string; name: string; generic_name?: string; strength?: string; form?: string; schedule?: string; high_alert?: boolean; in_stock: number }

const NOTE_FIELDS: { key: string; label: string; std: boolean }[] = [
  { key: 'chief_complaint', label: 'Chief complaint', std: true }, { key: 'hpi', label: 'History of present illness', std: true },
  { key: 'examination', label: 'Examination', std: true }, { key: 'assessment', label: 'Assessment', std: false }, { key: 'plan', label: 'Plan', std: true },
  { key: 'past_history', label: 'Past medical history', std: false }, { key: 'family_history', label: 'Family history', std: false },
  { key: 'social_history', label: 'Personal / social history', std: false }, { key: 'ros', label: 'Review of systems', std: false },
  { key: 'allergies_note', label: 'Allergies (note)', std: false }, { key: 'current_medications', label: 'Current medications', std: false },
  { key: 'provisional_diagnosis', label: 'Provisional diagnosis', std: false }, { key: 'differential_diagnosis', label: 'Differential diagnosis', std: false },
  { key: 'investigations_advised', label: 'Investigations advised (note)', std: false },
]
const ROUTES = ['Oral', 'IV', 'IM', 'SC', 'Topical', 'Inhalation', 'Sublingual', 'PR', 'Ophthalmic', 'Other']
const FREQS = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', 'Q4H', 'Q6H', 'Q8H', 'Weekly']
const PER_DAY: Record<string, number> = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, STAT: 1, Q4H: 6, Q6H: 4, Q8H: 3, Weekly: 1 / 7 }
const DOSES = ['1 tab', '½ tab', '2 tabs', '1 cap', '5 ml', '10 ml', '250 mg', '500 mg', '650 mg', '1 g', '1 puff', '2 puffs', '1 drop', '1 sachet', 'Apply']
const SEV: Record<string, BadgeTone> = { Contraindicated: 'red', Major: 'red', Moderate: 'amber', Minor: 'gray' }
type Rail = 'vitals' | 'labs' | 'trends' | 'history' | 'documents' | 'summary'

export default function OpEmr() {
  const { encounterId = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const key = ['x', 'opd', 'emr', encounterId]
  const emr = useQuery({ queryKey: key, queryFn: () => api<Emr>(`/opd/emr/${encounterId}`) })
  const cfg = useScreenConfig('op.clinical_note')
  const [note, setNote] = useState<Record<string, string>>({})
  const [cons, setCons] = useState<Record<string, unknown>>({})
  const [rx, setRx] = useState<RxItem[]>([])
  const [rxNotes, setRxNotes] = useState('')
  const [fmt, setFmt] = useState<string>('')
  const [dirty, setDirty] = useState<{ note: boolean; rx: boolean }>({ note: false, rx: false })
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [rail, setRail] = useState<Rail | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const loaded = useRef<string | null>(null)

  useEffect(() => {
    const d = emr.data
    if (!d || loaded.current === d.encounter.id) return
    loaded.current = d.encounter.id
    const c: Rec = d.consultation ?? ({} as Rec)
    const n = (c.note as Record<string, string>) ?? {}
    setNote({ chief_complaint: c.chief_complaint ?? d.appointment?.reason ?? d.assessment?.chief_complaint ?? '', hpi: c.hpi ?? '', examination: c.examination ?? '', plan: c.plan ?? '', ...n })
    setCons({ diagnosis: c.diagnosis ?? '', icd_code: c.icd_code ?? '', advice: c.advice ?? '', follow_up_at: c.follow_up_at ? String(c.follow_up_at).slice(0, 16) : '',
      review_with_reports: !!c.review_with_reports, referred_to: c.referred_to ?? null })
    setRx(d.prescription?.items ?? [])
    setRxNotes(d.prescription?.notes ?? '')
    setFmt(d.note_format)
  }, [emr.data])

  const editable = !!emr.data?.can_edit
  const payload = { note, consultation: cons, note_format: fmt || undefined }
  const save = useMutation({
    mutationFn: (withRx: boolean) => api<{ alerts: Alert[] }>(`/opd/emr/${encounterId}`, { method: 'PUT',
      body: { ...payload, prescription: withRx ? { items: rx, notes: rxNotes || null } : undefined } }),
    onMutate: () => setSaveState('saving'),
    onSuccess: (r, withRx) => {
      setSaveState('saved')
      setDirty((d) => ({ note: false, rx: withRx ? false : d.rx }))
      if (withRx) { setAlerts(r.alerts ?? []); qc.invalidateQueries({ queryKey: key }) }
    },
    onError: (e) => { setSaveState('error'); toast.error(errorMessage(e)) },
  })
  // autosave the note / diagnosis / advice (prescriptions are saved explicitly — they run the safety check)
  const debounced = useDebounced(JSON.stringify(payload), 1500)
  useEffect(() => {
    if (editable && dirty.note && !save.isPending) save.mutate(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const close = useMutation({
    mutationFn: async () => {
      await api(`/opd/emr/${encounterId}`, { method: 'PUT', body: { ...payload, prescription: dirty.rx ? { items: rx, notes: rxNotes || null } : undefined } })
      return api<{ follow_up?: { due_date: string } | null }>(`/opd/emr/${encounterId}/close`, { method: 'POST' })
    },
    onSuccess: (r) => { toast.success(`Encounter closed${r.follow_up ? ` · follow-up ${r.follow_up.due_date}` : ''}`); qc.invalidateQueries({ queryKey: ['x'] }); nav(-1) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  if (emr.isLoading) return <Spinner label="Opening the encounter…" />
  if (emr.error) return <ErrorBox error={emr.error} />
  const d = emr.data!
  const p = d.patient
  const rules = cfg.data?.fields ?? {}
  const visible = (k: string, std: boolean) => (rules[k] ? !rules[k].hidden && rules[k].visible !== false : std)
  const lbl = (k: string, fallback: string) => rules[k]?.label || fallback
  const order = (k: string, i: number) => rules[k]?.order ?? i
  const noteFields = NOTE_FIELDS.map((f, i) => ({ ...f, i })).filter((f) => visible(f.key, f.std)).sort((a, b) => order(a.key, a.i) - order(b.key, b.i))
  const statusTone: BadgeTone = d.encounter.status === 'Open' ? 'blue' : d.encounter.status === 'Closed' ? 'green' : 'red'
  const setN = (k: string, v: string) => { setNote((s) => ({ ...s, [k]: v })); setDirty((x) => ({ ...x, note: true })) }
  const setC = (k: string, v: unknown) => { setCons((s) => ({ ...s, [k]: v })); setDirty((x) => ({ ...x, note: true })) }

  return (
    <div className="xl:pr-14">
      <PageHeader icon="Stethoscope" title={<span className="font-mono">{d.encounter.code}</span>}
        badge={<Badge tone={statusTone}>{d.encounter.status.toUpperCase()}</Badge>}
        subtitle={<span><Link to={`/patients/${p.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{p.title}</Link> · {p.code} · {[p.age != null ? `${p.age}y` : null, p.gender].filter(Boolean).join(' / ')}
          {d.appointment ? ` · ${d.appointment.type ?? 'New'}${d.appointment.token_no ? ` · token ${d.appointment.token_no}` : ''}` : ''} · {d.encounter.doctor} · {d.encounter.department}</span>}
        actions={<>
          {editable && <span className="text-xs text-ink-3">{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}</span>}
          <Button size="sm" icon="ArrowLeft" onClick={() => nav(-1)}>Back</Button>
          {editable && <Button size="sm" variant="success" icon="CircleCheck" loading={close.isPending} onClick={() => close.mutate()}>Close</Button>}
          {editable && <Button size="sm" variant="danger" icon="CircleSlash" onClick={() => setCancelOpen(true)}>Cancel</Button>}
        </>} />

      {!editable && d.encounter.status === 'Open' && <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">View only — the consulting doctor writes this encounter.</p>}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">Department layout</span>
        <Select className="h-8 w-60" value={fmt} disabled={!editable} onChange={(e) => { setFmt(e.target.value); setDirty((x) => ({ ...x, note: true })) }}>
          {d.note_formats.map((f) => <option key={f.key} value={f.key}>{f.key === d.department_format ? "This patient's department" : f.label}</option>)}
        </Select>
        <span className="text-xs text-ink-3">drawn with {d.note_formats.find((f) => f.key === fmt)?.label ?? fmt}'s format</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Chip icon={<Zap className="size-3.5" />}>{d.problems.length} active problem{d.problems.length === 1 ? '' : 's'}{d.problems.length ? `: ${d.problems.slice(0, 3).map((x) => x.problem).join(', ')}` : ''}</Chip>
        <Chip icon={<AlertTriangle className="size-3.5" />} tone={d.allergies.length ? 'red' : undefined}>{d.allergies.length ? `Allergies: ${d.allergies.map((a) => a.allergen).join(', ')}` : 'No known allergies'}</Chip>
        <Chip icon={<Link2 className="size-3.5" />}>{d.active_meds.length} active med{d.active_meds.length === 1 ? '' : 's'}{d.active_meds.length ? `: ${d.active_meds.slice(0, 3).map((m) => m.name).join(', ')}` : ''}</Chip>
        {d.vitals.latest && <Chip icon={<Activity className="size-3.5" />}>BP {d.vitals.latest.bp_systolic ?? '—'}/{d.vitals.latest.bp_diastolic ?? '—'} · HR {d.vitals.latest.pulse ?? '—'} · SpO₂ {d.vitals.latest.spo2 ?? '—'} · T {d.vitals.latest.temperature ?? '—'}°F{d.vitals.latest.news2 != null ? ` · NEWS2 ${d.vitals.latest.news2}` : ''}</Chip>}
      </div>

      <div className="space-y-3">
        <AiSummary emr={d} canGenerate={editable} hasInput={!!d.vitals.latest || Object.values(note).some((x) => x?.trim())} />

        <Card title="Clinical note" icon="NotebookPen">
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {noteFields.map((f) => (
              <NoteField key={f.key} field={f.key} label={lbl(f.key, f.label)} value={note[f.key] ?? ''} onChange={(v) => setN(f.key, v)} disabled={!editable}
                patientId={String(p.id)} encounterId={encounterId} />
            ))}
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{d.note_formats.find((f) => f.key === fmt)?.label} — structured findings</div>
            <FormRunner key={fmt} formKey={`op.note.${fmt}`} patientId={String(p.id)} encounterId={encounterId} readOnly={!editable} hideHistory />
          </div>
        </Card>

        <Medications emr={d} rx={rx} setRx={(r) => { setRx(r); setDirty((x) => ({ ...x, rx: true })) }} notes={rxNotes} setNotes={(v) => { setRxNotes(v); setDirty((x) => ({ ...x, rx: true })) }}
          editable={editable && d.can_prescribe} dirty={dirty.rx} saving={save.isPending} onSave={() => save.mutate(true)} alerts={alerts} />

        <Documents emr={d} editable={editable} onUploaded={() => qc.invalidateQueries({ queryKey: key })} />

        <Investigations emr={d} editable={editable} onOrdered={() => qc.invalidateQueries({ queryKey: key })} />

        <Card title="Advice, follow-up & diagnosis" icon="ClipboardCheck">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {visible('diagnosis', true) && <Diagnosis label={lbl('diagnosis', 'Diagnosis')} value={String(cons.diagnosis ?? '')} code={String(cons.icd_code ?? '')} disabled={!editable}
              onChange={(dx, code) => { setC('diagnosis', dx); if (code !== undefined) setC('icd_code', code) }} />}
            {visible('icd_code', true) && <FieldWrap label={lbl('icd_code', 'ICD-10 code')}><Input value={String(cons.icd_code ?? '')} disabled={!editable} onChange={(e) => setC('icd_code', e.target.value.toUpperCase())} placeholder="e.g. I10" /></FieldWrap>}
            {visible('follow_up_date', true) && <FieldWrap label={lbl('follow_up_date', 'Follow-up')}><Input type="datetime-local" value={String(cons.follow_up_at ?? '')} disabled={!editable} onChange={(e) => setC('follow_up_at', e.target.value)} /></FieldWrap>}
            {visible('referred_to', false) && <FieldWrap label={lbl('referred_to', 'Cross-refer to department')}><RefPicker refName="mdm.departments" value={(cons.referred_to as string) ?? null} disabled={!editable} onChange={(v) => setC('referred_to', v)} /></FieldWrap>}
            {visible('advice', true) && <FieldWrap label={lbl('advice', 'Advice')} className="md:col-span-2"><Textarea rows={2} value={String(cons.advice ?? '')} disabled={!editable} placeholder="Enter advice…" onChange={(e) => setC('advice', e.target.value)} /></FieldWrap>}
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink"><input type="checkbox" className="size-4 accent-brand-700" disabled={!editable} checked={!!cons.review_with_reports} onChange={(e) => setC('review_with_reports', e.target.checked)} /> Review with reports</label>
          </div>
        </Card>
      </div>

      {/* right quick-panel rail */}
      <nav className="no-print fixed right-3 top-1/3 z-30 hidden flex-col gap-1 rounded-2xl border border-line bg-surface p-1.5 shadow-lg xl:flex" aria-label="Quick panels">
        {([['vitals', ClipboardList, 'Vitals & nursing'], ['labs', FlaskConical, 'Lab & imaging results'], ['trends', LineIcon, 'Trends'], ['history', History, 'Past visits'],
          ['documents', FolderOpen, 'Documents'], ['summary', FileText, 'Visit summary']] as const).map(([k, Ico, title]) => (
          <button key={k} type="button" title={title} aria-label={title} onClick={() => setRail(k)}
            className={cn('grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-surface-2 hover:text-ink', rail === k && 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white')}><Ico className="size-4" /></button>
        ))}
      </nav>
      <div className="no-print mt-3 flex flex-wrap gap-1 xl:hidden">
        {(['vitals', 'labs', 'trends', 'history', 'documents', 'summary'] as Rail[]).map((k) => <Button key={k} size="xs" onClick={() => setRail(k)}>{k[0].toUpperCase() + k.slice(1)}</Button>)}
      </div>
      <RailDrawer rail={rail} onClose={() => setRail(null)} emr={d} note={note} cons={cons} rx={rx} />
      <CancelModal open={cancelOpen} onClose={() => setCancelOpen(false)} encounterId={encounterId} onDone={() => { qc.invalidateQueries({ queryKey: ['x'] }); nav(-1) }} />
    </div>
  )
}

function Chip({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: 'red' }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-lg px-2 py-1 ring-1 ring-inset', tone === 'red' ? 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/30' : 'bg-surface text-ink-2 ring-line')}>{icon}{children}</span>
}

function NoteField({ field, label, value, onChange, disabled, patientId, encounterId }: { field: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean; patientId: string; encounterId: string }) {
  const [hist, setHist] = useState(false)
  const h = useQuery({ queryKey: ['x', 'opd', 'field-history', patientId, field], queryFn: () => api<{ value: string; date: string; doctor?: string }[]>(`/opd/patients/${patientId}/field-history`, { query: { key: field } }), enabled: hist })
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {!disabled && <NarrativeTools value={value} onChange={onChange} field={field} formKey="op.clinical_note" patientId={patientId} encounterId={encounterId} copy={false} />}
        <button type="button" onClick={() => setHist(!hist)} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-ink-2 ring-1 ring-inset ring-line-2 hover:bg-surface-2" title="Earlier values"><History className="size-3.5" /> History</button>
      </div>
      <Textarea rows={3} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={`Enter ${label.toLowerCase()}…`} />
      {hist && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-2 p-2 text-xs scroll-thin">
          {h.isLoading && 'Loading…'}
          {h.data?.length === 0 && <span className="text-ink-3">Nothing recorded earlier.</span>}
          {h.data?.map((x, i) => (
            <button key={i} type="button" disabled={disabled} onClick={() => onChange(value ? `${value}\n${x.value}` : x.value)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-surface">
              <span className="text-ink-3">{dateTime(x.date)} · {x.doctor}</span><span className="line-clamp-2 block text-ink">{x.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AiSummary({ emr, canGenerate, hasInput }: { emr: Emr; canGenerate: boolean; hasInput: boolean }) {
  const [out, setOut] = useState<{ content: string; status: string; notice?: string | null } | null>(emr.ai_summary ? { content: emr.ai_summary.content, status: emr.ai_summary.status } : null)
  const gen = useMutation({
    mutationFn: () => api<{ draft: { content: string; status: string }; notice?: string | null; review_required: boolean }>(`/ai/patients/${emr.patient.id}/summary`, { method: 'POST' }),
    onSuccess: (r) => setOut({ content: r.draft.content, status: r.draft.status, notice: r.notice }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <section className="rounded-xl border border-pink-200 bg-pink-50/60 p-4 dark:border-pink-500/20 dark:bg-pink-500/5">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-pink-600" /><span className="text-sm font-semibold text-ink">AI visit summary</span><Badge tone="violet">AI GENERATED</Badge>
        {out && <Badge tone={out.status === 'Approved' ? 'green' : 'amber'}>{out.status === 'Pending Review' ? 'Needs clinician review' : out.status}</Badge>}
        {canGenerate && <Button size="sm" variant="primary" className="ml-auto" icon="Sparkles" disabled={!hasInput} loading={gen.isPending} onClick={() => gen.mutate()}>Generate summary</Button>}
      </div>
      {out ? <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{out.content}</p> : <p className="mt-2 text-sm text-ink-2">Enter vitals or a clinical note first, then generate a summary.</p>}
      {out?.notice && <p className="mt-1 text-xs text-ink-3">{out.notice}</p>}
    </section>
  )
}

// ------------------------------------------------------------------ medications

function Medications({ emr, rx, setRx, notes, setNotes, editable, dirty, saving, onSave, alerts }: {
  emr: Emr; rx: RxItem[]; setRx: (r: RxItem[]) => void; notes: string; setNotes: (v: string) => void; editable: boolean; dirty: boolean; saving: boolean; onSave: () => void; alerts: Alert[]
}) {
  const blank = { drug: null as string | null, drug_name: '', name: '', dose: '', route: 'Oral', frequency: 'BD', duration_days: 5, qty: 10, instructions: '' }
  const [row, setRow] = useState<RxItem & { free?: boolean }>(blank)
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const drugs = useQuery({ queryKey: ['x', 'opd', 'drugs', dq], queryFn: () => api<Drug[]>('/opd/drugs', { query: { q: dq } }), enabled: dq.length >= 2 && !row.drug && !row.free })
  const [prev, setPrev] = useState<'add' | 'history' | null>(null)
  const [live, setLive] = useState<Alert[]>([])
  const autoQty = (f?: string | null, days?: number | null) => (f && PER_DAY[f] && days ? Math.max(1, Math.ceil(PER_DAY[f] * days)) : 1)
  const check = async (items: RxItem[]) => {
    const coded = items.filter((x) => x.drug).map((x) => ({ item_id: x.drug!, qty: Number(x.qty) || 1 }))
    if (!coded.length) { setLive([]); return }
    try { setLive((await api<{ alerts: Alert[] }>('/pharmacy/check', { method: 'POST', body: { patient_id: emr.patient.id, items: coded } })).alerts) } catch { /* advisory only */ }
  }
  const add = () => {
    if (!row.drug && !row.drug_name?.trim()) { toast.error('Choose a drug or type its name'); return }
    const next = [...rx, { ...row, free: undefined } as RxItem]
    setRx(next)
    setRow(blank)
    setQ('')
    void check(next)
  }
  const all = [...alerts, ...live.filter((a) => !alerts.some((b) => b.message === a.message))]
  return (
    <Card title="Medications" icon="Pill" actions={editable && <>
      <Button size="xs" icon="RotateCcw" onClick={() => setPrev('add')}>Add from previous</Button>
      <Button size="xs" icon="CalendarClock" onClick={() => setPrev('history')}>History</Button>
    </>}>
      {editable && (
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="relative min-w-60 flex-1">
            {row.free
              ? <Input autoFocus placeholder="Drug name (not in the formulary)" value={row.drug_name ?? ''} onChange={(e) => setRow({ ...row, drug_name: e.target.value })} />
              : row.drug
                ? <div className="flex h-9 items-center justify-between rounded-lg border border-line-2 bg-surface px-3 text-sm">{row.name}<button type="button" className="text-ink-3" onClick={() => setRow({ ...row, drug: null, name: '' })} aria-label="Change drug">×</button></div>
                : <Input placeholder="Search drug…" value={q} onChange={(e) => setQ(e.target.value)} />}
            {!!drugs.data?.length && !row.drug && !row.free && (
              <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
                {drugs.data.map((dr) => (
                  <li key={dr.id}><button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                    onClick={() => setRow({ ...row, drug: dr.id, name: dr.name, dose: row.dose || '1 tab' })}>
                    <span><span className="text-ink">{dr.name}</span> <span className="text-xs text-ink-3">{[dr.generic_name, dr.strength, dr.form].filter(Boolean).join(' · ')}</span>
                      {dr.high_alert && <Badge tone="red" className="ml-1">High alert</Badge>}{dr.schedule && dr.schedule !== 'None' && <Badge tone="amber" className="ml-1">Sch {dr.schedule}</Badge>}</span>
                    <span className={cn('text-xs', dr.in_stock > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}>{dr.in_stock > 0 ? `${dr.in_stock} in stock` : 'Out of stock'}</span>
                  </button></li>
                ))}
              </ul>
            )}
          </div>
          <Button variant="ghost" size="sm" title="Free-text drug" aria-label="Free-text drug" onClick={() => setRow({ ...blank, free: !row.free })}><Pencil className="size-4" /></Button>
          <Select className="w-24" value={row.dose ?? ''} onChange={(e) => setRow({ ...row, dose: e.target.value })} aria-label="Dose"><option value="">Dose</option>{DOSES.map((x) => <option key={x}>{x}</option>)}</Select>
          <Select className="w-20" value={row.frequency ?? ''} aria-label="Frequency" onChange={(e) => setRow({ ...row, frequency: e.target.value, qty: autoQty(e.target.value, row.duration_days) })}>{FREQS.map((x) => <option key={x}>{x}</option>)}</Select>
          <Select className="w-24" value={row.route ?? 'Oral'} aria-label="Route" onChange={(e) => setRow({ ...row, route: e.target.value })}>{ROUTES.map((x) => <option key={x}>{x}</option>)}</Select>
          <Input className="w-16" type="number" min={1} aria-label="Quantity" placeholder="Qty" value={row.qty ?? ''} onChange={(e) => setRow({ ...row, qty: Number(e.target.value) || 0 })} />
          <div className="flex items-center gap-1"><Input className="w-16" type="number" min={0} aria-label="Days" placeholder="Days" value={row.duration_days ?? ''}
            onChange={(e) => { const days = Number(e.target.value) || 0; setRow({ ...row, duration_days: days, qty: autoQty(row.frequency, days) }) }} /><span className="text-xs text-ink-3">d</span></div>
          <Input className="min-w-48 flex-1" placeholder="Instructions (e.g. after food)" value={row.instructions ?? ''} onChange={(e) => setRow({ ...row, instructions: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
          <Button variant="primary" onClick={add} aria-label="Add medicine"><Plus className="size-4" /></Button>
        </div>
      )}
      {all.length > 0 && (
        <ul className="mt-3 space-y-1">
          {all.map((a, i) => <li key={i} className="flex items-start gap-2 text-sm"><Badge tone={SEV[a.severity] ?? 'gray'}>{a.severity}</Badge><span className="text-ink">{a.message}</span></li>)}
        </ul>
      )}
      {rx.length === 0 ? <p className="mt-3 text-sm text-ink-3">No medicines prescribed.</p> : (
        <table className="mt-3 w-full text-sm">
          <thead className="border-b border-line text-xs text-ink-2"><tr>{['#', 'Medicine', 'Dose', 'Frequency', 'Route', 'Days', 'Qty', 'Instructions', ''].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rx.map((x, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-2 py-1.5 text-xs text-ink-3">{i + 1}</td>
                <td className="px-2 py-1.5 text-ink">{x.name || x.drug_name}{!x.drug && <Badge tone="gray" className="ml-1">free text</Badge>}{x.high_alert && <Badge tone="red" className="ml-1">High alert</Badge>}</td>
                <td className="px-2 py-1.5">{x.dose}</td><td className="px-2 py-1.5">{x.frequency}</td><td className="px-2 py-1.5">{x.route}</td><td className="px-2 py-1.5">{x.duration_days}</td>
                <td className="px-2 py-1.5">{x.qty}</td><td className="px-2 py-1.5 text-ink-2">{x.instructions}</td>
                <td className="px-2 py-1.5">{editable && <button type="button" className="rounded p-1 text-red-600" aria-label="Remove" onClick={() => { const n = rx.filter((_, j) => j !== i); setRx(n); void check(n) }}><Trash2 className="size-4" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input className="min-w-64 flex-1" placeholder="Prescription notes (printed)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button variant="primary" icon="Save" disabled={!dirty} loading={saving} onClick={onSave}>{emr.prescription ? 'Update prescription' : 'Save prescription'}</Button>
        </div>
      )}
      {emr.prescription && <p className="mt-1 text-xs text-ink-3">Prescription {emr.prescription.code} · {emr.prescription.status} — sent to the OP pharmacy queue.</p>}
      <PreviousRx open={!!prev} mode={prev ?? 'history'} patientId={String(emr.patient.id)} onClose={() => setPrev(null)}
        onAdd={(items) => { const n = [...rx, ...items]; setRx(n); setPrev(null); void check(n) }} />
    </Card>
  )
}

function PreviousRx({ open, mode, patientId, onClose, onAdd }: { open: boolean; mode: 'add' | 'history'; patientId: string; onClose: () => void; onAdd: (i: RxItem[]) => void }) {
  const q = useQuery({ queryKey: ['x', 'opd', 'prev-rx', patientId], queryFn: () => api<{ id: string; code: string; prescribed_at: string; doctor?: string; diagnosis?: string; status: string; items: RxItem[] }[]>(`/opd/patients/${patientId}/prescriptions`), enabled: open })
  return (
    <Modal open={open} onClose={onClose} size="lg" title={mode === 'add' ? 'Add from a previous prescription' : 'Prescription history'}>
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && <Empty icon="Pill" title="No earlier prescriptions" />}
      <ul className="space-y-2">
        {q.data?.map((r) => (
          <li key={r.id} className="rounded-lg border border-line p-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-ink-2">{r.code}</span><span className="text-ink-2">{dateTime(r.prescribed_at)} · {r.doctor}</span><Badge tone="gray">{r.status}</Badge>
              {mode === 'add' && <Button size="xs" variant="primary" className="ml-auto" onClick={() => onAdd(r.items.map((i) => ({ ...i })))}>Add all</Button>}</div>
            {r.diagnosis && <div className="text-xs text-ink-3">{r.diagnosis}</div>}
            <ul className="mt-1 text-xs text-ink">{r.items.map((i, j) => <li key={j}>• {i.name || i.drug_name} {i.dose} {i.frequency} × {i.duration_days}d ({i.qty}){i.instructions ? ` — ${i.instructions}` : ''}</li>)}</ul>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

// ------------------------------------------------------------------ documents, investigations, diagnosis

function Documents({ emr, editable, onUploaded }: { emr: Emr; editable: boolean; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Card title="Prescription documents" icon="Paperclip" actions={editable && <>
      <input ref={input} type="file" className="hidden" accept="image/*,application/pdf" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ''
        if (!f) return
        setBusy(true)
        try { await uploadFile(f, String(emr.patient.id)); toast.success('Attached'); onUploaded() } catch (err) { toast.error(errorMessage(err)) } finally { setBusy(false) }
      }} />
      <Button size="xs" icon="Upload" loading={busy} onClick={() => input.current?.click()}>Attach file</Button>
    </>}>
      {emr.documents.length === 0 ? <p className="text-sm text-ink-3">No documents for this patient.</p> : (
        <ul className="flex flex-wrap gap-2">{emr.documents.slice(0, 12).map((f) => (
          <li key={f.id}><a href={apiUrl(`/files/${f.id}`, undefined, true)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs text-ink ring-1 ring-line hover:ring-brand-600">
            <FileText className="size-3.5" />{f.name}<span className="text-ink-3">{dateTime(f.created_at)}</span></a></li>
        ))}</ul>
      )}
    </Card>
  )
}

interface CatService { id: string; code: string; name: string; category: string; rate?: number }

function Investigations({ emr, editable, onOrdered }: { emr: Emr; editable: boolean; onOrdered: () => void }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<CatService[]>([])
  const [priority, setPriority] = useState<'Routine' | 'Urgent' | 'STAT'>('Routine')
  const cat = useQuery({ queryKey: ['x', 'orders', 'catalogue'], queryFn: () => api<{ services: CatService[] }>('/orders/catalogue'), enabled: editable, staleTime: 10 * 60_000 })
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (t.length < 2) return []
    return (cat.data?.services ?? []).filter((s) => `${s.name} ${s.code}`.toLowerCase().includes(t) && !picked.some((p) => p.id === s.id)).slice(0, 12)
  }, [q, cat.data, picked])
  const order = useMutation({
    mutationFn: (confirmDup: boolean) => api<{ count: number }>('/orders/cpoe', { method: 'POST', body: {
      patient_id: emr.patient.id, encounter_id: emr.encounter.id, items: picked.map((s) => ({ service_id: s.id, priority })), confirm_duplicates: confirmDup } }),
    onSuccess: (r) => { toast.success(`${r.count} investigation(s) ordered — billed at the OP counter`); setPicked([]); onOrdered() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_ORDER' && window.confirm(`${e.message}. Order again?`)) { order.mutate(true); return }
      toast.error(errorMessage(e))
    },
  })
  return (
    <Card title="Investigations advised" icon="FlaskConical">
      {editable && (
        <div className="space-y-2">
          <div className="relative">
            <Input placeholder="Search tests and services…" value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
                {hits.map((s) => <li key={s.id}><button type="button" onClick={() => { setPicked([...picked, s]); setQ('') }} className="flex w-full justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2">
                  <span>{s.name} <span className="text-xs text-ink-3">{s.code} · {s.category}</span></span><span className="tabular text-xs text-ink-2">{money(s.rate)}</span></button></li>)}
              </ul>
            )}
          </div>
          {picked.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {picked.map((s) => <Badge key={s.id} tone="blue">{s.name}<button type="button" aria-label={`Remove ${s.name}`} className="ml-1" onClick={() => setPicked(picked.filter((x) => x.id !== s.id))}>×</button></Badge>)}
              <Select className="h-8 w-28" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}><option>Routine</option><option>Urgent</option><option>STAT</option></Select>
              <Button size="sm" variant="primary" loading={order.isPending} onClick={() => order.mutate(false)}>Order {picked.length}</Button>
            </div>
          )}
        </div>
      )}
      {emr.orders.length > 0 ? (
        <ul className="mt-2 divide-y divide-line text-sm">
          {emr.orders.map((o) => <li key={o.id} className="flex items-center gap-2 py-1.5"><span className="font-mono text-xs text-ink-3">{o.code}</span><span className="flex-1 text-ink">{o.test}</span>
            {o.priority !== 'Routine' && <Badge tone="red">{o.priority}</Badge>}{o.critical && <Badge tone="red">Critical</Badge>}<Badge tone="gray">{o.status}</Badge></li>)}
        </ul>
      ) : !editable && <p className="text-sm text-ink-3">No investigations ordered.</p>}
    </Card>
  )
}

function Diagnosis({ label, value, code, onChange, disabled }: { label: string; value: string; code: string; onChange: (dx: string, code?: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const dq = useDebounced(value, 250)
  const q = useQuery({ queryKey: ['x', 'opd', 'icd10', dq], queryFn: () => api<{ code: string; name: string }[]>('/opd/icd10', { query: { q: dq } }), enabled: open && dq.length >= 2 })
  return (
    <FieldWrap label={label} className="relative md:col-span-2" required help={code ? `ICD-10 ${code}` : 'Type to search ICD-10'}>
      <Input value={value} disabled={disabled} placeholder="Enter diagnosis…" onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }} />
      {open && !!q.data?.length && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
          {q.data.map((x) => <li key={x.code}><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(x.name, x.code); setOpen(false) }} className="flex w-full gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2">
            <span className="w-14 font-mono text-xs text-ink-2">{x.code}</span><span className="text-ink">{x.name}</span></button></li>)}
        </ul>
      )}
    </FieldWrap>
  )
}

function CancelModal({ open, onClose, encounterId, onDone }: { open: boolean; onClose: () => void; encounterId: string; onDone: () => void }) {
  const [reason, setReason] = useState('Entered in error')
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => api<{ refund_due: boolean }>(`/opd/emr/${encounterId}/cancel`, { method: 'POST', body: { reason, note: note || null } }),
    onSuccess: (r) => { toast.success(r.refund_due ? 'Encounter cancelled — the consultation was already billed: refund it at the OP counter' : 'Encounter cancelled'); onDone() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Cancel this OP encounter" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>Cancel encounter</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)}>
          {['Entered in error', 'Patient left without consultation', 'Wrong patient', 'Duplicate visit', 'Other'].map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
        <FieldWrap label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></FieldWrap>
        <p className="text-xs text-ink-3">Unstarted orders and the active prescription are cancelled; an unbilled consultation charge is reversed. Audited.</p>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ rail panels

function RailDrawer({ rail, onClose, emr, note, cons, rx }: { rail: Rail | null; onClose: () => void; emr: Emr; note: Record<string, string>; cons: Record<string, unknown>; rx: RxItem[] }) {
  const titles: Record<Rail, string> = { vitals: 'Vitals & nursing assessment', labs: 'Lab & imaging', trends: 'Vitals trends', history: 'Past visits', documents: 'Documents', summary: 'Visit summary' }
  const v = emr.vitals.latest
  const series = emr.vitals.series.map((x) => ({ t: time(x.recorded_at), sbp: x.bp_systolic, dbp: x.bp_diastolic, pulse: x.pulse, spo2: x.spo2 }))
  return (
    <Drawer open={!!rail} onClose={onClose} title={rail ? titles[rail] : ''} width="max-w-xl">
      <div className="space-y-3 p-5 text-sm">
        {rail === 'vitals' && (v ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              {[['BP', `${v.bp_systolic ?? '—'}/${v.bp_diastolic ?? '—'}`], ['Pulse', v.pulse], ['SpO₂', v.spo2], ['Temp °F', v.temperature], ['RR', v.resp_rate], ['Pain', v.pain_score],
                ['Weight', v.weight], ['Height', v.height], ['BMI', v.bmi], ['RBS', v.blood_sugar], ['Standing BP', v.standing_bp_systolic ? `${v.standing_bp_systolic}/${v.standing_bp_diastolic}` : null], ['NEWS2', v.news2]].map(([l, x]) => (
                <div key={String(l)}><div className="text-xs text-ink-3">{l}</div><div className="font-medium text-ink">{x ?? '—'}</div></div>
              ))}
            </div>
            <p className="text-xs text-ink-3">Recorded {dateTime(v.recorded_at)}</p>
            {emr.assessment && <div className="rounded-lg bg-surface-2 p-3"><div className="mb-1 text-xs font-semibold uppercase text-ink-3">Nursing assessment</div>
              {['chief_complaint', 'pain_location', 'fall_risk', 'nutrition_risk', 'mobility', 'pregnancy_status', 'current_medications', 'observations'].filter((k) => emr.assessment?.[k]).map((k) => (
                <div key={k}><span className="text-ink-3">{k.replace(/_/g, ' ')}:</span> {String(emr.assessment![k])}</div>))}</div>}
          </>) : <Empty icon="Activity" title="No vitals recorded for this visit" />)}
        {rail === 'labs' && (emr.orders.length ? emr.orders.map((o) => <div key={o.id} className="flex items-center gap-2"><span className="flex-1">{o.test}</span><Badge tone="gray">{o.status}</Badge></div>)
          : <p className="text-ink-3">No investigations on this visit.</p>)}
        {rail === 'labs' && <Link to={`/patients/${emr.patient.id}`} className="text-brand-700 hover:underline dark:text-brand-300">All results in the patient record →</Link>}
        {rail === 'trends' && (series.length > 1
          ? <div className="h-64"><Lines data={series} x="t" series={[{ key: 'sbp', label: 'Systolic' }, { key: 'dbp', label: 'Diastolic' }, { key: 'pulse', label: 'Pulse' }, { key: 'spo2', label: 'SpO₂' }]} /></div>
          : <Empty icon="LineChart" title="Not enough readings for a trend" />)}
        {rail === 'history' && (emr.history.length ? emr.history.map((h) => (
          <div key={h.id} className="rounded-lg border border-line p-2.5"><div className="text-xs text-ink-3">{dateTime(h.date)} · {h.doctor} · {h.department}</div>
            <div className="text-ink">{h.diagnosis || h.chief_complaint || '—'}</div><div className="text-xs text-ink-3">{h.medicines} medicine(s){h.follow_up ? ` · follow-up ${String(h.follow_up).slice(0, 10)}` : ''}</div></div>
        )) : <p className="text-ink-3">No earlier consultations.</p>)}
        {rail === 'documents' && (emr.documents.length ? emr.documents.map((f) => <a key={f.id} href={apiUrl(`/files/${f.id}`, undefined, true)} target="_blank" rel="noreferrer" className="block text-brand-700 hover:underline dark:text-brand-300">{f.name} <span className="text-xs text-ink-3">{dateTime(f.created_at)}</span></a>) : <p className="text-ink-3">No documents.</p>)}
        {rail === 'summary' && (
          <>
            <div id="op-visit-summary" className="space-y-2">
              <div><b>{emr.patient.title}</b> · {emr.patient.code} · {emr.encounter.code} · {dateTime(emr.encounter.started_at)}</div>
              {Object.entries(note).filter(([, x]) => x?.trim()).map(([k, x]) => <div key={k}><span className="text-ink-3">{NOTE_FIELDS.find((f) => f.key === k)?.label ?? k}:</span> {x}</div>)}
              <div><span className="text-ink-3">Diagnosis:</span> {String(cons.diagnosis || '—')} {cons.icd_code ? `(${String(cons.icd_code)})` : ''}</div>
              {rx.length > 0 && <div><span className="text-ink-3">Rx:</span><ul>{rx.map((x, i) => <li key={i}>{i + 1}. {x.name || x.drug_name} {x.dose} {x.frequency} × {x.duration_days}d — {x.instructions}</li>)}</ul></div>}
              {!!cons.advice && <div><span className="text-ink-3">Advice:</span> {String(cons.advice)}</div>}
              {!!cons.follow_up_at && <div><span className="text-ink-3">Follow-up:</span> {dateTime(cons.follow_up_at)}</div>}
            </div>
            <Button icon="Printer" onClick={() => {
              const w = window.open('', '_blank'); const el = document.getElementById('op-visit-summary')
              if (!w || !el) return
              w.document.write(`<!doctype html><title>Prescription ${emr.encounter.code}</title><style>body{font:13px system-ui;margin:24px}</style><h2>Prescription / visit summary</h2><div>Dr ${emr.encounter.doctor ?? ''} · ${emr.encounter.department ?? ''}</div><hr/>${el.innerHTML}<script>onload=()=>print()</script>`)
              w.document.close()
            }}>Print prescription</Button>
          </>
        )}
      </div>
    </Drawer>
  )
}

