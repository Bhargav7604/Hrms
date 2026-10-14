import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import {
  Badge, Button, cn, Drawer, Empty, ErrorBox, FieldWrap, Input, KeyValue, Modal, Select, Spinner, StatTile, StatusBadge, Tabs, Textarea,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { dateTime, nowLocal, time } from '@/lib/format'
import type { BespokeProps } from './index'
import { PatientCell, PriorityBadge, ResultView, TatCell, Timeline, useStatAlerts, type OrderDetail, type WorkRow, type Worklist } from './lab-worklist'

interface Template { id: string; name: string; modality?: string | null; body_part?: string | null; template: string; builtin: boolean }

type Stage = 'schedule' | 'scheduled' | 'report' | 'sign' | 'done'
const STAGE_LABEL: Record<Stage, string> = {
  schedule: 'To schedule', scheduled: 'Scheduled', report: 'Scanning / to report', sign: 'To sign', done: 'Completed today',
}
const WAITING = ['Ordered', 'Collected']
const TRANSPORT_MODES = ['Wheelchair', 'Stretcher', 'Trolley', 'Trolley with monitor & O2', 'Bed', 'Walking with escort']

function stageOf(r: WorkRow): Stage | null {
  if (WAITING.includes(r.status)) return r.scheduled_at ? 'scheduled' : 'schedule'
  if (r.status === 'In Progress') return 'report'
  if (r.status === 'Resulted') return 'sign'
  if (r.status === 'Verified') return 'done'
  return null
}
const isInpatient = (r: WorkRow) => !['OPD', 'Emergency', 'IPD (discharged)'].includes(r.location)

export default function RadWorklist(_: BespokeProps) {
  const qc = useQueryClient()
  const role = useMeta().data?.user.role ?? ''
  const [stage, setStage] = useState<Stage>('schedule')
  const [modality, setModality] = useState('')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState<WorkRow | null>(null)
  useStatAlerts('RAD')
  const isRad = ['radiology', 'admin'].includes(role)

  const list = useQuery({
    queryKey: ['x', 'orders', 'worklist', 'RAD', modality],
    queryFn: () => api<Worklist>('/orders/worklist', { query: { category: 'RAD', section: modality || undefined } }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })
  const start = useMutation({
    mutationFn: (id: string) => api<OrderDetail>(`/orders/${id}/start`, { method: 'POST', body: {} }),
    onSuccess: (o) => { toast.success(`Study started · accession ${o.accession_no}`); qc.invalidateQueries({ queryKey: ['x', 'orders'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const term = q.trim().toLowerCase()
  const all = list.data?.rows ?? []
  const counts = useMemo(() => {
    const m: Record<Stage, number> = { schedule: 0, scheduled: 0, report: 0, sign: 0, done: 0 }
    for (const r of all) { const s = stageOf(r); if (s) m[s] += 1 }
    return m
  }, [all])
  const rows = useMemo(() => {
    const out = all.filter((r) => stageOf(r) === stage
      && (!term || [r.code, r.accession_no, r.patient.uhid, r.patient.name, r.test.name].some((v) => v?.toLowerCase().includes(term))))
    if (stage === 'scheduled') out.sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))
    return out
  }, [all, stage, term])

  if (list.isLoading) return <Spinner label="Loading radiology worklist…" />
  if (list.error) return <ErrorBox error={list.error} />

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile icon="CalendarPlus" label="To schedule" value={counts.schedule} onClick={() => setStage('schedule')} />
        <StatTile icon="CalendarClock" label="Scheduled" value={counts.scheduled} onClick={() => setStage('scheduled')} />
        <StatTile icon="Scan" label="Scanning / to report" value={counts.report} onClick={() => setStage('report')} />
        <StatTile icon="FileCheck" label="Awaiting sign-off" value={counts.sign} onClick={() => setStage('sign')} />
        <StatTile icon="Siren" label="STAT pending" value={list.data!.stat} tone={list.data!.stat ? 'alert' : 'default'} />
        <StatTile icon="Timer" label="Past report TAT" value={list.data!.overdue} tone={list.data!.overdue ? 'alert' : 'default'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Accession, order no., UHID, patient, study" aria-label="Search studies" />
        </div>
        <Select value={modality} onChange={(e) => setModality(e.target.value)} className="max-w-48 shrink-0" aria-label="Modality">
          <option value="">All modalities</option>
          {list.data!.sections.map((s) => <option key={s}>{s}</option>)}
        </Select>
        <span className="ml-auto text-xs text-ink-3">Live · {time(list.data!.generated_at)}</span>
      </div>

      <Tabs value={stage} onChange={setStage} tabs={(Object.keys(STAGE_LABEL) as Stage[]).map((s) => ({ key: s, label: STAGE_LABEL[s], count: counts[s] }))} />

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['Priority', 'Order / accession', 'Patient', 'Study', stage === 'scheduled' ? 'Slot' : 'Ordered', 'TAT', 'Status', ''].map((h, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)}
                  className={cn('cursor-pointer border-b border-line last:border-0 hover:bg-surface-2', r.overdue && r.status !== 'Verified' && 'bg-red-50/60 dark:bg-red-500/5')}>
                  <td className="px-3 py-2"><PriorityBadge priority={r.priority} /></td>
                  <td className="whitespace-nowrap px-3 py-2"><div className="font-mono text-xs text-ink">{r.code}</div>{r.accession_no && <div className="font-mono text-xs text-ink-3">{r.accession_no}</div>}</td>
                  <td className="max-w-56 px-3 py-2"><PatientCell p={r.patient} location={r.location} /></td>
                  <td className="px-3 py-2">
                    <div className="text-ink">{r.test.name}</div>
                    <div className="text-xs text-ink-3">{[r.test.modality, r.test.body_part].filter(Boolean).join(' · ')}{r.test.contrast && <Badge tone="amber" className="ml-1">Contrast</Badge>}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{stage === 'scheduled' ? dateTime(r.scheduled_at) : dateTime(r.ordered_at)}</td>
                  <td className="px-3 py-2"><TatCell r={r} /></td>
                  <td className="px-3 py-2"><span className="flex items-center gap-1"><StatusBadge status={r.status} />{r.critical && <Badge tone="red">Critical</Badge>}</span></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="inline-flex gap-1.5">
                      {WAITING.includes(r.status) && isRad && <Button size="xs" onClick={() => setScheduling(r)}>{r.scheduled_at ? 'Reschedule' : 'Schedule'}</Button>}
                      {WAITING.includes(r.status) && isRad && <Button size="xs" variant="primary" icon="Play" loading={start.isPending && start.variables === r.id} onClick={() => start.mutate(r.id)}>Start</Button>}
                      {r.status === 'In Progress' && isRad && <Button size="xs" variant="primary" icon="FileText" onClick={() => setOpenId(r.id)}>Report</Button>}
                      {r.status === 'Resulted' && <Button size="xs" variant="success" onClick={() => setOpenId(r.id)}>Review & sign</Button>}
                      {r.pacs_url && <a href={r.pacs_url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-brand-700 hover:bg-surface-2 dark:text-brand-300"><ExternalLink className="size-3.5" />PACS</a>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Empty icon="MonitorDot" title={term ? 'No studies match' : `Nothing ${STAGE_LABEL[stage].toLowerCase()}`} />}
      </div>

      {scheduling && <ScheduleModal r={scheduling} onClose={() => setScheduling(null)} />}
      {openId && <RadOrderDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function nextSlot(): string {
  const d = new Date(Date.now() + 30 * 60_000)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0)
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function ScheduleModal({ r, onClose }: { r: WorkRow; onClose: () => void }) {
  const qc = useQueryClient()
  const [when, setWhen] = useState(r.scheduled_at ? r.scheduled_at.slice(0, 16) : nextSlot())
  const [room, setRoom] = useState<string | null>(r.modality_room ?? null)
  const [transport, setTransport] = useState(isInpatient(r))
  const [mode, setMode] = useState('Wheelchair')
  const save = useMutation({
    mutationFn: () => api<OrderDetail & { transport_request?: { code: string } | null }>(`/orders/${r.id}/schedule`, {
      method: 'POST', body: { scheduled_at: when, modality_room: room, request_transport: transport && isInpatient(r), transport_mode: mode },
    }),
    onSuccess: (o) => {
      toast.success(`${r.test.name} scheduled for ${dateTime(o.scheduled_at)}${o.transport_request ? ` · porter requested (${o.transport_request.code})` : ''}`)
      qc.invalidateQueries({ queryKey: ['x', 'orders'] })
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title={`Schedule ${r.test.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="CalendarPlus" loading={save.isPending} disabled={!when} onClick={() => save.mutate()}>Schedule</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-2">{r.patient.name} · {r.patient.uhid} · {r.location}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldWrap label="Date & time" required><Input type="datetime-local" value={when} min={nowLocal()} onChange={(e) => setWhen(e.target.value)} /></FieldWrap>
          <FieldWrap label="Modality room" help="Slot clashes in the same room are blocked">
            <RefPicker refName="radiology.modalities" value={room} onChange={(id) => setRoom(id)} filter={r.test.modality ? { modality: r.test.modality } : undefined} placeholder="Any room" />
          </FieldWrap>
        </div>
        {isInpatient(r) && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 p-3">
            <label className="inline-flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="size-4 accent-brand-700" checked={transport} onChange={(e) => setTransport(e.target.checked)} />
              Request porter from the ward (15 min before)
            </label>
            {transport && (
              <Select value={mode} onChange={(e) => setMode(e.target.value)} className="max-w-56 shrink-0" aria-label="Transport mode">
                {TRANSPORT_MODES.map((m) => <option key={m}>{m}</option>)}
              </Select>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function RadOrderDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const q = useQuery({ queryKey: ['x', 'orders', 'detail', id], queryFn: () => api<OrderDetail>(`/orders/${id}/detail`) })
  const o = q.data
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<OrderDetail>(`/orders/${id}/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: (_, v) => {
      toast.success(v.path === 'verify' ? 'Report signed and released' : v.path === 'start' ? 'Study started' : 'Report saved')
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['x', 'orders'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const can = (a: string) => !!o?.actions.includes(a)
  const reporting = !!o && (can('result') || editing)

  return (
    <Drawer open onClose={onClose} width="max-w-4xl"
      title={o ? <span className="flex items-center gap-2">{o.test.name} <StatusBadge status={o.status} />{o.critical && <Badge tone="red">Critical</Badge>}</span> : 'Study'}
      subtitle={o && <span className="font-mono text-xs">{o.code}{o.accession_no && ` · ${o.accession_no}`} · {o.priority}</span>}
      headerExtra={o?.pacs_url && (
        <a href={o.pacs_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2">
          <ExternalLink className="size-4" /> Open in PACS
        </a>
      )}
      footer={o && !reporting && (
        <>
          {can('start') && <Button variant="primary" icon="Play" loading={act.isPending} onClick={() => act.mutate({ path: 'start' })}>Start study</Button>}
          {can('amend') && <Button icon="Pencil" onClick={() => setEditing(true)}>Edit report</Button>}
          {can('verify') && <Button variant="success" icon="ShieldCheck" loading={act.isPending} onClick={() => act.mutate({ path: 'verify' })}>Verify & sign</Button>}
        </>
      )}>
      {q.isLoading && <Spinner />}
      {q.error && <div className="p-5"><ErrorBox error={q.error} /></div>}
      {o && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-surface-2 p-3">
            <PatientCell p={o.patient} location={o.location} />
            <div className="text-right text-xs text-ink-2">
              {o.ordering_doctor && <div>Referred by {o.ordering_doctor}</div>}
              {o.clinical_notes && <div className="max-w-xs text-ink">Clinical details: {o.clinical_notes}</div>}
            </div>
          </div>
          <Timeline o={o} extra={o.scheduled_at ? [{ label: 'Scheduled', at: o.scheduled_at }] : undefined} />
          <KeyValue cols={3} items={[
            { label: 'Modality', value: [o.test.modality, o.test.body_part].filter(Boolean).join(' · ') || '—' },
            { label: 'Room', value: o.modality_room_name ?? '—' },
            { label: 'Accession', value: o.accession_no ? <span className="font-mono">{o.accession_no}</span> : 'Assigned when the study starts' },
          ]} />
          {o.test.contrast && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">Contrast study — check renal function, allergy history and consent before injection.</p>}
          {o.prep_instructions && <p className="text-xs text-ink-2">Preparation: {o.prep_instructions}</p>}
          {reporting
            ? <ReportEditor o={o} saving={act.isPending} onCancel={editing ? () => setEditing(false) : undefined}
                onSave={(body) => act.mutate({ path: 'results', body })} />
            : <ResultView o={o} />}
          {o.verified_by && <p className="text-xs text-ink-3">Signed by {o.verified_by} · {dateTime(o.verified_at)}</p>}
        </div>
      )}
    </Drawer>
  )
}

function ReportEditor({ o, saving, onSave, onCancel }: {
  o: OrderDetail; saving: boolean; onSave: (b: { result: string; impression?: string; critical: boolean }) => void; onCancel?: () => void
}) {
  const [report, setReport] = useState(o.result ?? '')
  const [impression, setImpression] = useState(o.impression ?? '')
  const [critical, setCritical] = useState(o.critical)
  const [tpl, setTpl] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const templates = useQuery({
    queryKey: ['x', 'orders', 'rad-templates', o.test.modality, o.test.body_part],
    queryFn: () => api<Template[]>('/orders/rad-templates', { query: { modality: o.test.modality ?? undefined, body_part: o.test.body_part ?? undefined } }),
    staleTime: 5 * 60_000,
  })
  const insert = () => {
    const t = templates.data?.find((x) => x.id === tpl)
    if (!t) return
    const el = area.current
    if (!report.trim() || !el) { setReport(t.template); return }
    const at = el.selectionStart ?? report.length
    setReport(`${report.slice(0, at)}${report.slice(0, at).endsWith('\n') || at === 0 ? '' : '\n'}${t.template}${report.slice(at)}`)
  }
  const pullImpression = () => {
    const m = report.match(/IMPRESSION:\s*([\s\S]+)$/i)
    if (m) setImpression(m[1].trim())
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <FieldWrap label="Report template" className="min-w-64 flex-1">
          <Select value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Report template">
            <option value="">{templates.isLoading ? 'Loading templates…' : 'Choose a template…'}</option>
            {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? ' (standard)' : ''}</option>)}
          </Select>
        </FieldWrap>
        <Button size="sm" icon="Plus" disabled={!tpl} onClick={insert}>{report.trim() ? 'Insert at cursor' : 'Use template'}</Button>
      </div>
      <FieldWrap label="Report" required>
        <Textarea ref={area} rows={14} value={report} onChange={(e) => setReport(e.target.value)} className="font-mono text-[13px] leading-relaxed"
          placeholder="TECHNIQUE: …&#10;&#10;FINDINGS: …&#10;&#10;IMPRESSION: …" />
      </FieldWrap>
      <FieldWrap label={<span className="flex items-center justify-between">Impression <button type="button" className="text-xs font-normal text-brand-700 hover:underline dark:text-brand-300" onClick={pullImpression}>Copy from report</button></span>}>
        <Textarea rows={2} value={impression} onChange={(e) => setImpression(e.target.value)} />
      </FieldWrap>
      <label className={cn('flex items-center gap-2 rounded-lg p-2 text-sm', critical ? 'bg-red-600 text-white' : 'bg-surface-2 text-ink')}>
        <input type="checkbox" className="size-4 accent-red-600" checked={critical} onChange={(e) => setCritical(e.target.checked)} />
        Critical / unexpected finding — alert the referring clinician now
      </label>
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button variant="primary" icon="Save" loading={saving} disabled={!report.trim()}
          onClick={() => onSave({ result: report, impression: impression || undefined, critical })}>Save report</Button>
      </div>
    </div>
  )
}
