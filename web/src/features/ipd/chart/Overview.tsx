import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Lines } from '@/components/charts'
import { Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, Segmented, Select, Spinner, Tabs } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, nowLocal, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K, vitalTone, type ChartHeader, type VisitTracker, type VitalPoint } from '../api'
import { Section, StageBadge } from '../ui'
import { ProgressNotes } from './Notes'
import { OrderDetailModal } from './OrderDetail'

type Go = (tab: string, sub?: string) => void

interface OverviewData {
  investigations: { id: string; code: string; test: string; status: string; stage: string; priority: string; ordered_at: string; ordered_by?: string; critical: boolean }[]
  medications: { name: string; detail?: string; qty?: number; issued_qty?: number | null; at?: string; source: string; ref?: string; status?: string }[]
  procedures: { id: string; at: string; description: string; type: string; status: string }[]
  notes: { id: string; note_type: string; noted_at: string; author?: string; shift?: string | null; note: string }[]
  tracker: VisitTracker
}

const WINDOWS = [{ key: '24h', label: '24 hours' }, { key: '3d', label: '3 days' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }] as const
type Win = (typeof WINDOWS)[number]['key']

export function newsTone(score?: number | null) {
  if (score == null) return 'gray' as const
  return score >= 7 ? 'red' as const : score >= 5 ? 'amber' as const : 'green' as const
}

function Tile({ icon, label, value, unit, status, tone }: { icon: string; label: string; value: ReactNode; unit?: string; status?: string | null; tone: string }) {
  const t = vitalTone(status)
  return (
    <div className="flex gap-2 rounded-lg border border-line p-2.5">
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', tone)}><Icon name={icon} className="size-4" /></span>
      <div className="min-w-0">
        <div className="text-xs text-ink-2">{label}</div>
        <div className={cn('text-lg font-semibold tabular-nums leading-tight', t === 'red' ? 'text-red-700 dark:text-red-300' : t === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>
          {value ?? '—'}{value != null && unit && <span className="ml-1 text-xs font-normal text-ink-3">{unit}</span>}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-ink-3"><span className={cn('size-1.5 rounded-full', t === 'green' ? 'bg-emerald-500' : t === 'amber' ? 'bg-amber-500' : t === 'red' ? 'bg-red-500' : 'bg-slate-400')} />{status ?? 'Not recorded'}</div>
      </div>
    </div>
  )
}

/** Vitals tiles with range status, NEWS2 and the multi-series trend (24 h / 3 / 7 / 30 days). */
export function VitalsPanel({ aid, canRecord, onRecord }: { aid: string; canRecord: boolean; onRecord: () => void }) {
  const [win, setWin] = useState<Win>('24h')
  const [collapsed, setCollapsed] = useState(false)
  const q = useQuery({ queryKey: K.vitals(aid, win), queryFn: () => api<{ series: VitalPoint[]; latest: VitalPoint | null }>(`/ipchart/admissions/${aid}/vitals`, { query: { window: win } }) })
  const v = q.data?.latest
  const data = useMemo(() => (q.data?.series ?? []).map((p) => ({
    t: win === '24h' ? time(p.recorded_at) : dateTime(p.recorded_at).replace(/ \d{4},/, ','), Systolic: p.bp_systolic, Diastolic: p.bp_diastolic, Pulse: p.pulse, 'SpO₂': p.spo2, 'Temp °C': p.temperature_c,
  })), [q.data, win])
  return (
    <Section title="Vitals & monitoring" icon="HeartPulse" tone="teal"
      subtitle={v ? `last recorded ${dateTime(v.recorded_at)}${v.recorded_by_name ? ` by ${v.recorded_by_name}` : ''}` : 'nothing recorded yet'}
      actions={<>
        {v?.news2 != null && <Badge tone={newsTone(v.news2)}><b>{v.news2}</b> NEWS2 · {v.news2_risk} risk</Badge>}
        {canRecord && <Button size="sm" icon="Plus" onClick={onRecord}>Record vitals</Button>}
        <button type="button" className="rounded p-1 text-ink-3 hover:bg-surface-2" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'}><Icon name={collapsed ? 'ChevronDown' : 'ChevronUp'} className="size-4" /></button>
      </>}>
      {!collapsed && (q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile icon="Heart" label="Blood pressure" value={v?.bp_systolic != null ? `${v.bp_systolic}/${v.bp_diastolic ?? '—'}` : null} unit="mmHg" status={v?.status.bp} tone="bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300" />
            <Tile icon="Activity" label="Pulse" value={v?.pulse} unit="bpm" status={v?.status.pulse} tone="bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300" />
            <Tile icon="Thermometer" label="Temperature" value={v?.temperature_c} unit="°C" status={v?.status.temperature_c} tone="bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-300" />
            <Tile icon="Droplet" label="SpO₂" value={v?.spo2} unit={`%${v?.o2_support && v.o2_support !== 'Room air' ? ` · ${v.o2_support}` : ''}`} status={v?.status.spo2} tone="bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" />
            <Tile icon="Wind" label="Resp. rate" value={v?.resp_rate} unit="/min" status={v?.status.resp_rate} tone="bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300" />
            <Tile icon="Calculator" label="BMI" value={v?.bmi} status={v?.status.bmi} tone="bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" />
            {v?.blood_sugar != null && <Tile icon="Pipette" label="GRBS" value={v.blood_sugar} unit="mg/dL" status={v.status.blood_sugar} tone="bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-300" />}
            {v?.pain_score != null && <Tile icon="Frown" label="Pain" value={v.pain_score} unit="/10" status={v.status.pain_score === 'High' ? 'Moderate' : v.status.pain_score === 'Critical high' ? 'Severe' : v.status.pain_score} tone="bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" />}
          </div>
          <div className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Segmented value={win} onChange={setWin} options={WINDOWS.map((w) => ({ key: w.key, label: w.label }))} />
              <span className="text-[11px] text-ink-3">{data.length} reading{data.length === 1 ? '' : 's'}</span>
            </div>
            <div className="h-56">
              {data.length === 0 ? <div className="grid h-full place-items-center text-sm text-ink-3">No readings in the last {WINDOWS.find((w) => w.key === win)!.label}.</div>
                : data.length === 1 ? <div className="grid h-full place-items-center text-sm text-ink-3">One reading in this window — the trend appears from the second.</div>
                : <Lines data={data} x="t" series={[{ key: 'Systolic', label: 'Systolic' }, { key: 'Diastolic', label: 'Diastolic' }, { key: 'Pulse', label: 'Pulse' }, { key: 'SpO₂', label: 'SpO₂' }, { key: 'Temp °C', label: 'Temp °C' }]} />}
            </div>
          </div>
        </div>
      ))}
    </Section>
  )
}

export interface ChartItHandle { open: () => void }
const EMPTY = { bp_systolic: '', bp_diastolic: '', pulse: '', resp_rate: '', spo2: '', temperature_c: '', blood_sugar: '', pain_score: '', o2_support: 'Room air' }
const FIELDS: { key: keyof typeof EMPTY; label: string; unit: string; icon: string; step?: string }[] = [
  { key: 'bp_systolic', label: 'Sys', unit: 'mmHg', icon: 'Heart' }, { key: 'bp_diastolic', label: 'Dia', unit: 'mmHg', icon: 'Heart' },
  { key: 'pulse', label: 'Pulse', unit: 'bpm', icon: 'Activity' }, { key: 'resp_rate', label: 'RR', unit: '/min', icon: 'Wind' },
  { key: 'spo2', label: 'SpO₂', unit: '%', icon: 'Droplet' }, { key: 'temperature_c', label: 'Temp', unit: '°C', icon: 'Thermometer', step: '0.1' },
  { key: 'blood_sugar', label: 'GRBS', unit: 'mg/dL', icon: 'Pipette' }, { key: 'pain_score', label: 'Pain', unit: '0–10', icon: 'Frown' },
]

/** "Chart it" — inline observation entry; out-of-range values are listed in the confirmation. */
export const ChartIt = forwardRef<ChartItHandle, { aid: string }>(function ChartIt({ aid }, ref) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [v, setV] = useState(EMPTY)
  const [at, setAt] = useState(nowLocal())
  const first = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ open: () => { setOpen(true); setAt(nowLocal()); setTimeout(() => { box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.current?.focus() }, 50) } }))
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { taken_at: at, o2_support: v.o2_support }
      for (const f of FIELDS) if (v[f.key] !== '') body[f.key] = Number(v[f.key])
      return api<{ out_of_range: { label: string; value: number; status: string }[]; news2: number | null; news2_risk: string | null }>(`/ipchart/admissions/${aid}/observations`, { method: 'POST', body })
    },
    onSuccess: (r) => {
      const out = r.out_of_range
      const msg = out.length ? `Observations recorded — ${out.map((o) => `${o.label} ${o.status.toLowerCase()}`).join(', ')}` : 'Observations recorded — all within range'
      if (out.some((o) => o.status.startsWith('Critical')) || (r.news2 ?? 0) >= 5) toast.warning(`${msg}${r.news2 != null ? ` · NEWS2 ${r.news2} (${r.news2_risk})` : ''}`, { duration: 10000 })
      else toast.success(`${msg}${r.news2 != null ? ` · NEWS2 ${r.news2}` : ''}`)
      setV(EMPTY); setAt(nowLocal())
      qc.invalidateQueries({ queryKey: ['x', 'emr', 'ipchart', aid] }); qc.invalidateQueries({ queryKey: K.chart(aid) })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const filled = FIELDS.some((f) => v[f.key] !== '')
  return (
    <div ref={box} className="rounded-xl border border-line bg-surface">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-ink-2 hover:bg-surface-2" aria-expanded={open}>
        <span className="flex items-center gap-2"><Icon name="HeartPulse" className="size-4 text-teal-600" /><b className="text-ink">Chart it</b> — record observations</span>
        <Icon name={open ? 'ChevronUp' : 'ChevronDown'} className="size-4" />
      </button>
      {open && (
        <form className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (filled) save.mutate() }}>
          {FIELDS.map((f, i) => (
            <FieldWrap key={f.key} label={<span className="inline-flex items-center gap-1"><Icon name={f.icon} className="size-3" />{f.label}</span>} help={f.unit} className="w-[5.5rem]">
              <Input ref={i === 0 ? first : undefined} type="number" inputMode="decimal" step={f.step ?? '1'} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} aria-label={`${f.label} (${f.unit})`} />
            </FieldWrap>
          ))}
          <FieldWrap label="O₂ support" help=" " className="w-36">
            <Select value={v.o2_support} onChange={(e) => setV({ ...v, o2_support: e.target.value })}>
              {['Room air', 'Nasal prongs', 'Face mask', 'Venturi mask', 'NRBM', 'HFNC', 'NIV (BiPAP/CPAP)', 'Ventilator'].map((o) => <option key={o}>{o}</option>)}
            </Select>
          </FieldWrap>
          <FieldWrap label={<span className="inline-flex items-center gap-1"><Icon name="CalendarClock" className="size-3" />Taken at</span>} help=" " className="w-52">
            <Input type="datetime-local" value={at} max={nowLocal()} onChange={(e) => setAt(e.target.value)} />
          </FieldWrap>
          <div className="pb-5"><Button type="submit" variant="primary" disabled={!filled} loading={save.isPending}>Record</Button></div>
        </form>
      )}
    </div>
  )
})

function QuickAction({ icon, label, onClick, tone }: { icon: string; label: string; onClick: () => void; tone: string }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-1.5 rounded-lg border border-line px-2 py-3 text-center text-xs font-medium text-ink hover:border-brand-600/40 hover:bg-surface-2">
      <span className={cn('grid size-8 place-items-center rounded-full', tone)}><Icon name={icon} className="size-4" /></span>{label}
    </button>
  )
}

export function VisitTrackerCard({ t, canAccept, onAccept, accepting, go }: { t?: VisitTracker; canAccept: boolean; onAccept: () => void; accepting: boolean; go: Go }) {
  if (!t) return null
  return (
    <Section title="Patient visit tracker" icon="ListChecks" tone="green" subtitle={`${t.done} of ${t.total} done · ${t.pending} pending`}>
      <ol className="relative space-y-3 before:absolute before:left-[9px] before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-line">
        {t.items.map((i) => (
          <li key={i.key} className="relative flex items-start gap-3">
            <span className={cn('z-[1] grid size-5 shrink-0 place-items-center rounded-full ring-2 ring-surface', i.done ? 'bg-emerald-600 text-white' : 'border-2 border-amber-400 bg-surface')}>
              {i.done && <Icon name="Check" className="size-3" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">{i.label}{i.optional && <span className="ml-1 text-[11px] font-normal text-ink-3">optional</span>}</div>
              <div className="text-xs text-ink-3">{i.done ? `${dateTime(i.at)}${i.by ? ` · ${i.by}` : ''}` : 'Pending'}</div>
            </div>
            {!i.done && (i.go.action === 'accept' ? (canAccept && <Button size="xs" variant="primary" loading={accepting} onClick={onAccept}>Accept</Button>)
              : <button type="button" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => go(i.go.tab, i.go.sub)}>Go →</button>)}
          </li>
        ))}
      </ol>
    </Section>
  )
}

/** Overview tab: vitals, chart it, quick actions, recent widgets, visit tracker, notes and timeline. */
export function Overview({ h, go, chartIt, onAccept, accepting, notesSlot }: { h: ChartHeader; go: Go; chartIt: React.RefObject<ChartItHandle | null>; onAccept: () => void; accepting: boolean; notesSlot: (tab: string) => ReactNode }) {
  const aid = h.admission.id
  const p = h.permissions
  const open = h.admission.status === 'Admitted' || h.admission.status === 'Discharge Initiated'
  const q = useQuery({ queryKey: K.overview(aid), queryFn: () => api<OverviewData>(`/ipchart/admissions/${aid}/overview`) })
  const [track, setTrack] = useState<string | null>(null)
  const [noteTab, setNoteTab] = useState('clinical')
  const [timeline, setTimeline] = useState(false)
  const d = q.data
  const quick = [
    p.observe && open && { icon: 'HeartPulse', label: 'Add observation', run: () => chartIt.current?.open(), tone: 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300' },
    p.indent && open && { icon: 'Pill', label: 'Add medication', run: () => go('order_medication'), tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' },
    p.order && open && { icon: 'FlaskConical', label: 'Add services', run: () => go('investigations'), tone: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' },
    (p.doctor_note || p.nursing_note) && open && { icon: 'NotebookPen', label: 'Add note', run: () => (p.doctor_note ? go('doctor', 'progress-notes') : go('nursing', 'nursing-notes')), tone: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
    p.tabs.doctor && { icon: 'FileOutput', label: 'IP discharge summary', run: () => go('doctor', 'discharge.summary'), tone: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' },
    p.tabs.nursing && { icon: 'MoveRight', label: 'Patient movement', run: () => go('nursing', 'tasks'), tone: 'bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-300' },
  ].filter(Boolean) as { icon: string; label: string; run: () => void; tone: string }[]

  return (
    <div className="space-y-4">
      {p.tabs.monitoring && <VitalsPanel aid={aid} canRecord={p.observe && open} onRecord={() => chartIt.current?.open()} />}
      {p.observe && open && <ChartIt ref={chartIt} aid={aid} />}
      <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)_minmax(0,0.85fr)]">
        <div className="space-y-4">
          {quick.length > 0 && (
            <Section title="Quick actions" icon="Zap" tone="blue">
              <div className="grid grid-cols-3 gap-2">{quick.map((x) => <QuickAction key={x.label} icon={x.icon} label={x.label} onClick={x.run} tone={x.tone} />)}</div>
            </Section>
          )}
          <VisitTrackerCard t={d?.tracker} canAccept={p.accept && open} onAccept={onAccept} accepting={accepting} go={go} />
        </div>
        <div className="space-y-4">
          {p.tabs.investigations && (
            <Section title="Recent investigations" icon="FlaskConical" tone="violet" pad={false} actions={<Button size="xs" variant="ghost" onClick={() => go('investigations')}>View all</Button>}>
              {q.isLoading ? <Spinner /> : !d?.investigations.length ? <Empty icon="FlaskConical" title="No investigations ordered yet" /> : (
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-ink-3"><tr>{['Date & time', 'Test', 'Status', 'Ordered by', ''].map((x) => <th key={x} className="px-3 py-1.5 text-left font-semibold">{x}</th>)}</tr></thead>
                  <tbody>{d.investigations.map((o) => (
                    <tr key={o.id} className="border-t border-line">
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{dateTime(o.ordered_at)}</td>
                      <td className="px-3 py-1.5 text-ink">{o.test}{o.priority !== 'Routine' && <Badge tone="red" className="ml-1">{o.priority}</Badge>}</td>
                      <td className="px-3 py-1.5"><StageBadge stage={o.stage} critical={o.critical} /></td>
                      <td className="px-3 py-1.5 text-xs text-ink-2">{o.ordered_by ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right"><button type="button" title="Track" aria-label={`Track ${o.test}`} onClick={() => setTrack(o.id)} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"><Icon name="Route" className="size-4" /></button></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Section>
          )}
          <Section title="Recent procedures & services" icon="Scissors" tone="teal" pad={false}
            actions={p.charge && open ? <Button size="xs" variant="ghost" icon="Plus" onClick={() => go('order_desk', 'procedure')}>Add procedure</Button> : undefined}>
            {q.isLoading ? <Spinner /> : !d?.procedures.length ? <Empty icon="Scissors" title="No procedures or services charged yet" /> : (
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-ink-3"><tr>{['Date & time', 'Procedure / service', 'Type', 'Status'].map((x) => <th key={x} className="px-3 py-1.5 text-left font-semibold">{x}</th>)}</tr></thead>
                <tbody>{d.procedures.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{dateTime(c.at)}</td>
                    <td className="px-3 py-1.5 text-ink">{c.description}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-2">{c.type}</td>
                    <td className="px-3 py-1.5"><Badge tone={c.status === 'Cancelled' ? 'gray' : 'green'}>{c.status}</Badge></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Section>
        </div>
        <div className="space-y-4">
          <Section title="Recent medications" icon="Pill" tone="green" pad={false} actions={p.indent && open ? <Button size="xs" variant="ghost" icon="Plus" onClick={() => go('order_medication')}>Add medication</Button> : undefined}>
            {q.isLoading ? <Spinner /> : !d?.medications.length ? <Empty icon="Pill" title="No medicines ordered yet" /> : (
              <ul className="divide-y divide-line">{d.medications.map((m, i) => (
                <li key={i} className="flex items-start justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0"><span className="block truncate text-ink">{m.name}</span><span className="block truncate text-xs text-ink-3">{m.detail ?? (m.qty != null ? `Qty ${m.qty}${m.issued_qty != null ? ` · issued ${m.issued_qty}` : ''}` : '')} · {m.source} {m.ref}</span></span>
                  {m.status && <Badge tone={m.status === 'Raised' ? 'amber' : m.status === 'Cancelled' ? 'gray' : 'green'}>{m.status}</Badge>}
                </li>
              ))}</ul>
            )}
          </Section>
          <Section title="Notes" icon="StickyNote" tone="amber" pad={false} actions={(p.doctor_note || p.nursing_note) && open ? <Button size="xs" variant="ghost" icon="Plus" onClick={() => (p.doctor_note ? go('doctor', 'progress-notes') : go('nursing', 'nursing-notes'))}>Add note</Button> : undefined}>
            {q.isLoading ? <Spinner /> : !d?.notes.length ? <Empty icon="StickyNote" title="No notes written yet" /> : (
              <ul className="divide-y divide-line">{d.notes.map((n) => (
                <li key={n.id} className="px-3 py-2 text-sm">
                  <div className="text-xs text-ink-3">{n.note_type}{n.shift ? ` · ${n.shift}` : ''} · {n.author} · {dateTime(n.noted_at)}</div>
                  <p className="line-clamp-2 text-ink">{n.note}</p>
                </li>
              ))}</ul>
            )}
          </Section>
        </div>
      </div>
      {(p.tabs.doctor || p.tabs.nursing || p.tabs.documents || p.tabs.consent) && (
        <div className="rounded-xl border border-line bg-surface">
          <Tabs className="px-3" value={noteTab} onChange={setNoteTab} tabs={[
            ...(p.tabs.doctor ? [{ key: 'clinical', label: 'Clinical notes' }] : []), ...(p.tabs.nursing ? [{ key: 'nursing', label: 'Nursing notes' }] : []),
            ...(p.tabs.doctor ? [{ key: 'summary', label: 'Discharge summary' }] : []), ...(p.tabs.documents ? [{ key: 'documents', label: 'Documents' }] : []),
            ...(p.tabs.consent ? [{ key: 'consent', label: 'Consent' }] : []),
          ]} />
          <div className="p-4">
            {noteTab === 'clinical' && p.tabs.doctor && <ProgressNotes aid={aid} kind="clinical" canWrite={p.doctor_note && open} defaultSpecialty={h.department?.name} />}
            {noteTab === 'nursing' && p.tabs.nursing && <ProgressNotes aid={aid} kind="nursing" canWrite={p.nursing_note && open} />}
            {noteTab !== 'clinical' && noteTab !== 'nursing' && notesSlot(noteTab)}
          </div>
        </div>
      )}
      <div className="rounded-xl border border-line bg-surface">
        <button type="button" className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2" onClick={() => setTimeline(!timeline)} aria-expanded={timeline}>
          <Icon name={timeline ? 'ChevronDown' : 'ChevronRight'} className="size-4" /> Timeline
        </button>
        {timeline && <Timeline aid={aid} />}
      </div>
      {track && <OrderDetailModal id={track} mode="track" onClose={() => setTrack(null)} />}
    </div>
  )
}

interface Ev { at: string; kind: string; title: string; detail?: string | null; by?: string | null; tone: string }
const KIND_ICON: Record<string, string> = {
  admission: 'BedDouble', acceptance: 'UserCheck', condition: 'HeartPulse', sponsor: 'Building2', patient: 'UserCog', transfer: 'ArrowLeftRight', order: 'FlaskConical',
  result: 'FileCheck2', void: 'Ban', vitals: 'Activity', note: 'NotebookPen', instruction: 'MessageSquareText', indent: 'Pill', consent: 'FileSignature',
  equipment: 'PlugZap', discharge: 'LogOut', clearance: 'ClipboardCheck', form: 'ClipboardList',
}

export function Timeline({ aid }: { aid: string }) {
  const q = useQuery({ queryKey: K.timeline(aid), queryFn: () => api<{ events: Ev[] }>(`/ipchart/admissions/${aid}/timeline`) })
  const [kind, setKind] = useState('all')
  if (q.isLoading) return <Spinner />
  if (q.error) return <div className="p-4"><ErrorBox error={q.error} /></div>
  const kinds = Array.from(new Set(q.data!.events.map((e) => e.kind)))
  const rows = q.data!.events.filter((e) => kind === 'all' || e.kind === kind)
  return (
    <div className="border-t border-line p-4">
      <div className="mb-3 flex flex-wrap gap-1">
        {['all', ...kinds].map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={cn('rounded-full px-2.5 py-0.5 text-xs ring-1 ring-inset', kind === k ? 'bg-brand-700 text-white ring-brand-700' : 'text-ink-2 ring-line-2 hover:bg-surface-2')}>{k}</button>
        ))}
      </div>
      <ol className="space-y-2">
        {rows.map((e, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="w-32 shrink-0 text-xs tabular-nums text-ink-3">{dateTime(e.at)}</span>
            <Icon name={KIND_ICON[e.kind] ?? 'Dot'} className={cn('mt-0.5 size-4 shrink-0', e.tone === 'red' ? 'text-red-600' : e.tone === 'green' ? 'text-emerald-600' : e.tone === 'amber' ? 'text-amber-600' : e.tone === 'blue' ? 'text-sky-600' : 'text-ink-3')} />
            <span className="min-w-0"><span className="text-ink">{e.title}</span>{e.by && <span className="text-xs text-ink-3"> · {e.by}</span>}{e.detail && <span className="block truncate text-xs text-ink-2">{e.detail}</span>}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
