import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanBarcode } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
  Badge, Button, cn, Drawer, Empty, ErrorBox, FieldWrap, Input, KeyValue, Modal, Select, Spinner, StatTile, StatusBadge, Tabs, Textarea,
  type BadgeTone,
} from '@/components/ui'
import { api, apiUrl, errorMessage, getToken } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { dateTime, minutes, time } from '@/lib/format'
import type { BespokeProps } from './index'

// ================================================================== shared worklist types & pieces (also used by rad-worklist)

export interface ResultValue { parameter: string; value?: string | null; unit?: string | null; ref_range?: string | null; flag?: string | null }
export interface WorkRow {
  id: string; code: string; status: string; category: string; priority: string
  patient: { id: string; name: string; uhid?: string | null; gender?: string | null; age?: number | null }
  encounter_id?: string | null; location: string
  test: { id: string | null; code?: string | null; name?: string | null; sample_type?: string | null; container?: string | null; modality?: string | null; body_part?: string | null; contrast?: boolean; section?: string | null }
  ordered_at: string; collected_at?: string | null; resulted_at?: string | null; verified_at?: string | null
  elapsed_minutes: number | null; target_minutes: number; due_at?: string | null; overdue: boolean
  critical: boolean; acknowledged_at?: string | null; acknowledged_by?: string | null; clinical_notes?: string | null
  sample_barcode?: string | null; scheduled_at?: string | null; modality_room?: string | null; accession_no?: string | null; pacs_url?: string | null
  result_values: ResultValue[]; result?: string | null; impression?: string | null; tat_minutes?: number | null
  verified_by?: string | null; resulted_by?: string | null; ordering_doctor?: string | null; verbal_order?: boolean; read?: boolean
}
export interface Param { parameter: string; unit?: string | null; ref_range?: string | null; ref_low?: number | null; ref_high?: number | null; critical_low?: number | null; critical_high?: number | null }
export interface OrderDetail extends WorkRow {
  parameters: Param[]; prep_instructions?: string | null; modality_room_name?: string | null; actions: string[]
  sample?: { id: string; code: string; status: string; barcode: string; sample_type?: string | null; collected_at?: string | null; received_at?: string | null; rejection_reason?: string | null } | null
}
export interface Worklist { rows: WorkRow[]; total: number; counts: Record<string, number>; sections: string[]; overdue: number; stat: number; generated_at: string }

const PRIORITY_TONE: Record<string, BadgeTone> = { STAT: 'red', Urgent: 'amber', Routine: 'gray' }

export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? 'gray'} className={priority === 'STAT' ? 'font-bold' : undefined}>{priority}</Badge>
}

export function PatientCell({ p, location }: { p: WorkRow['patient']; location?: string }) {
  return (
    <div className="min-w-0">
      <Link to={`/patients/${p.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium text-ink hover:underline">{p.name}</Link>
      <div className="truncate text-xs text-ink-3"><span className="font-mono">{p.uhid}</span>{p.age != null && ` · ${p.age}y`}{p.gender && ` ${p.gender[0]}`}{location && ` · ${location}`}</div>
    </div>
  )
}

/** Elapsed time against the TAT target (STAT/urgent targets are capped server-side). */
export function TatCell({ r }: { r: WorkRow }) {
  if (r.status === 'Verified') {
    const t = r.tat_minutes ?? r.elapsed_minutes
    return <span className={cn('tabular text-xs', t != null && t > r.target_minutes ? 'text-red-700 dark:text-red-300' : 'text-ink-2')}>TAT {minutes(t)}</span>
  }
  const e = r.elapsed_minutes ?? 0
  const pct = Math.min(100, (e / Math.max(1, r.target_minutes)) * 100)
  const tone = r.overdue ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="w-28">
      <div className={cn('tabular text-xs', r.overdue ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ink-2')}>
        {minutes(e)} / {minutes(r.target_minutes)}{r.overdue && ' · overdue'}
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line"><div className={cn('h-full', tone)} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

export function FlagBadge({ flag }: { flag?: string | null }) {
  if (!flag) return <span className="text-ink-3">—</span>
  const tone: BadgeTone = flag.startsWith('Critical') ? 'red' : flag === 'Normal' ? 'green' : 'amber'
  return <Badge tone={tone} className={flag.startsWith('Critical') ? 'font-bold' : undefined}>{flag}</Badge>
}

export function ResultView({ o }: { o: Pick<WorkRow, 'result_values' | 'result' | 'impression'> }) {
  return (
    <div className="space-y-3">
      {o.result_values.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['Parameter', 'Result', 'Unit', 'Reference', 'Flag'].map((h) => <th key={h} className="px-3 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {o.result_values.map((v, i) => (
                <tr key={i} className={cn('border-t border-line', v.flag?.startsWith('Critical') && 'bg-red-50 dark:bg-red-500/10')}>
                  <td className="px-3 py-1.5 text-ink">{v.parameter}</td>
                  <td className={cn('px-3 py-1.5 tabular font-medium', v.flag && v.flag !== 'Normal' ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{v.value ?? '—'}</td>
                  <td className="px-3 py-1.5 text-ink-2">{v.unit ?? ''}</td>
                  <td className="px-3 py-1.5 text-ink-2">{v.ref_range ?? '—'}</td>
                  <td className="px-3 py-1.5"><FlagBadge flag={v.flag} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {o.result && <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Report</h4><p className="whitespace-pre-wrap text-sm text-ink">{o.result}</p></div>}
      {o.impression && <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Impression</h4><p className="whitespace-pre-wrap text-sm font-medium text-ink">{o.impression}</p></div>}
      {!o.result_values.length && !o.result && !o.impression && <p className="text-sm text-ink-3">No result entered yet.</p>}
    </div>
  )
}

export function Timeline({ o, extra }: { o: WorkRow; extra?: { label: string; at?: string | null }[] }) {
  const steps = [
    { label: 'Ordered', at: o.ordered_at }, ...(extra ?? []),
    { label: o.category === 'LAB' ? 'Collected' : 'Started', at: o.category === 'LAB' ? o.collected_at : undefined },
    { label: 'Resulted', at: o.resulted_at }, { label: 'Verified', at: o.verified_at },
  ].filter((s) => s.label !== 'Started' || s.at)
  return (
    <ol className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {steps.map((s) => (
        <li key={s.label} className={cn('flex items-center gap-1.5', s.at ? 'text-ink' : 'text-ink-3')}>
          <span className={cn('size-2 rounded-full', s.at ? 'bg-brand-600' : 'bg-line-2')} />{s.label} {s.at ? time(s.at) : '—'}
        </li>
      ))}
      <li className="text-ink-2">Target {minutes(o.target_minutes)}{o.tat_minutes != null && ` · TAT ${minutes(o.tat_minutes)}`}</li>
    </ol>
  )
}

/** STAT orders are pushed on the realtime "alerts" channel; only the worklists react to them. */
export function useStatAlerts(category: 'LAB' | 'RAD') {
  const qc = useQueryClient()
  useEffect(() => {
    if (!getToken()) return
    const es = new EventSource(apiUrl('/realtime', { channels: 'alerts' }, true))
    es.addEventListener('alerts', (ev) => {
      try {
        const a = JSON.parse((ev as MessageEvent).data)
        if (a.type === 'stat_order' && a.category === category) {
          toast.error(`STAT ${category === 'LAB' ? 'lab' : 'imaging'} order: ${a.test} — ${a.patient}`, { duration: 20000 })
          qc.invalidateQueries({ queryKey: ['x', 'orders', 'worklist', category] })
        }
      } catch { /* ignore malformed */ }
    })
    return () => es.close()
  }, [category, qc])
}

// ================================================================== live flagging (mirrors the server rules)

const NEGATIVE = /^\s*(neg|non[- ]?reactive|not\s+(detected|seen|isolated|found)|nil|absent|no\s+growth|sterile|normal)/i
const POSITIVE = /^\s*(pos|reactive|detected|present|seen|isolated|growth|\+)|\b(falciparum|vivax)\b/i

export function liveFlag(value: string, p?: Param): string | null {
  const v = value.trim()
  if (!v) return null
  const n = Number(v.replace(/,/g, '').replace(/^[<>=≤≥\s]+/, ''))
  if (Number.isNaN(n)) return NEGATIVE.test(v) ? 'Normal' : POSITIVE.test(v) ? 'Abnormal' : null
  if (!p) return null
  if (p.critical_low != null && n <= p.critical_low) return 'Critical Low'
  if (p.critical_high != null && n >= p.critical_high) return 'Critical High'
  if (p.ref_low != null && n < p.ref_low) return 'Low'
  if (p.ref_high != null && n > p.ref_high) return 'High'
  return p.ref_low != null || p.ref_high != null ? 'Normal' : null
}

// ================================================================== Code 128 barcode for sample labels

const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232',
  '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221',
  '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113',
  '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123',
  '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221',
  '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241',
  '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311',
  '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112']

function code128(text: string): number[] {
  const numeric = /^\d+$/.test(text) && text.length % 2 === 0
  const codes = numeric
    ? [105, ...Array.from({ length: text.length / 2 }, (_, i) => Number(text.slice(i * 2, i * 2 + 2)))]
    : [104, ...[...text].map((ch) => Math.min(94, Math.max(0, ch.charCodeAt(0) - 32)))]
  const check = codes.reduce((sum, c, i) => sum + (i === 0 ? c : c * i), 0) % 103
  return [...codes, check, 106].flatMap((c) => C128[c].split('').map(Number))
}

function Barcode({ value }: { value: string }) {
  const widths = code128(value)
  const quiet = 10
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2
  const bars: ReactNode[] = []
  let x = quiet
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={w} height={40} />)
    x += w
  })
  return <svg viewBox={`0 0 ${total} 40`} preserveAspectRatio="none" shapeRendering="crispEdges" className="h-[9mm] w-full" fill="#000" aria-label={`Barcode ${value}`}>{bars}</svg>
}

interface Label {
  barcode: string; patient: { name: string; uhid?: string | null; age?: number | null; gender?: string | null }; tests: string[]
  order_codes: string[]; sample_type?: string | null; container?: string | null; collected_at?: string | null; priority: string
}

const LABEL_CSS = `
.p2-labels { display: none; }
@media print {
  @page { size: 50mm 25mm; margin: 0; }
  body > *:not(.p2-labels) { display: none !important; }
  .p2-labels { display: block !important; }
  .p2-label { width: 50mm; height: 25mm; padding: 1mm 2mm; box-sizing: border-box; page-break-after: always; break-after: page; overflow: hidden;
    font: 7pt/1.15 system-ui, sans-serif; color: #000; background: #fff; }
}`

function LabelCard({ l }: { l: Label }) {
  return (
    <div className="p2-label">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: '34mm' }}>{l.patient.name}</span>
        <span>{l.priority === 'STAT' ? 'STAT' : ''}</span>
      </div>
      <div>{l.patient.uhid} · {l.patient.age != null ? `${l.patient.age}y` : ''} {l.patient.gender?.[0] ?? ''} · {l.collected_at ? dateTime(l.collected_at) : ''}</div>
      <Barcode value={l.barcode} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><b style={{ letterSpacing: '0.5px' }}>{l.barcode}</b><span>{l.sample_type ?? ''}</span></div>
      <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{l.tests.join(', ')}</div>
    </div>
  )
}

/** Small-label print view: preview in a modal, the print stylesheet hides everything else. */
function LabelPrint({ labels, onClose }: { labels: Label[]; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300)
    return () => clearTimeout(t)
  }, [labels])
  return (
    <>
      <style>{LABEL_CSS}</style>
      {createPortal(<div className="p2-labels">{labels.map((l) => <LabelCard key={l.barcode} l={l} />)}</div>, document.body)}
      <Modal open onClose={onClose} title={`Sample label${labels.length > 1 ? 's' : ''} · ${labels.length} tube${labels.length > 1 ? 's' : ''}`}
        footer={<><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary" icon="Printer" onClick={() => window.print()}>Reprint</Button></>}>
        <div className="flex flex-wrap gap-3">
          {labels.map((l) => (
            <div key={l.barcode} className="w-[200px] rounded border border-line bg-white p-2 text-[11px] leading-tight text-black shadow-sm">
              <div className="flex justify-between font-bold"><span className="truncate">{l.patient.name}</span>{l.priority === 'STAT' && <span className="text-red-700">STAT</span>}</div>
              <div>{l.patient.uhid} · {l.patient.age != null ? `${l.patient.age}y` : ''} {l.patient.gender?.[0] ?? ''}</div>
              <Barcode value={l.barcode} />
              <div className="flex justify-between"><b className="tracking-wide">{l.barcode}</b><span>{l.sample_type}</span></div>
              <div className="truncate">{l.tests.join(', ')}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-3">Printed at 50 × 25 mm. Stick the label lengthwise on the tube with the barcode readable.</p>
      </Modal>
    </>
  )
}

// ================================================================== the lab worklist

type Stage = 'collect' | 'lab' | 'verify' | 'done'
const STAGES: Record<Stage, string[]> = { collect: ['Ordered'], lab: ['Collected', 'In Progress'], verify: ['Resulted'], done: ['Verified'] }
const STAGE_LABEL: Record<Stage, string> = { collect: 'To collect', lab: 'In lab', verify: 'To verify', done: 'Completed today' }

export default function LabWorklist(_: BespokeProps) {
  const qc = useQueryClient()
  const [stage, setStage] = useState<Stage>('collect')
  const [section, setSection] = useState('')
  const [scan, setScan] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [labels, setLabels] = useState<Label[] | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)
  useStatAlerts('LAB')

  const list = useQuery({
    queryKey: ['x', 'orders', 'worklist', 'LAB', section],
    queryFn: () => api<Worklist>('/orders/worklist', { query: { category: 'LAB', section: section || undefined } }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['x', 'orders'] })
  const role = useMeta().data?.user.role ?? ''
  const canCollect = ['lab', 'nurse', 'admin'].includes(role)
  const isLab = role === 'lab' || role === 'admin'

  const term = scan.trim().toLowerCase()
  const rows = useMemo(() => (list.data?.rows ?? []).filter((r) => STAGES[stage].includes(r.status)
    && (!term || [r.code, r.sample_barcode, r.patient.uhid, r.patient.name, r.test.name].some((v) => v?.toLowerCase().includes(term)))), [list.data, stage, term])
  useEffect(() => { setSelected(new Set()) }, [stage, section])

  const collect = useMutation({
    mutationFn: (ids: string[]) => api<{ labels: Label[] }>('/orders/collect', { method: 'POST', body: { order_ids: ids } }),
    onSuccess: (r) => { setLabels(r.labels); setSelected(new Set()); invalidate() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const receive = useMutation({
    mutationFn: (id: string) => api<{ orders: WorkRow[] }>(`/orders/${id}/receive`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(`Received ${r.orders.map((o) => o.code).join(', ')}`); invalidate() },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const onScan = async () => {
    if (!term) return
    const local = (list.data?.rows ?? []).filter((r) => [r.code, r.sample_barcode, r.patient.uhid].some((v) => v?.toLowerCase() === term))
    if (local.length === 1) { openRow(local[0]); return }
    if (local.length > 1) { const st = (Object.keys(STAGES) as Stage[]).find((k) => STAGES[k].includes(local[0].status)); if (st) setStage(st); return }
    try {
      const res = await api<Worklist>('/orders/worklist', { query: { category: 'LAB', q: scan.trim() } })
      if (res.rows.length === 1) openRow(res.rows[0])
      else if (res.rows.length === 0) toast.error(`No lab order found for “${scan.trim()}”`)
      else toast.message(`${res.rows.length} orders match — refine the search`)
    } catch (e) { toast.error(errorMessage(e)) }
  }
  const openRow = (r: WorkRow) => {
    const st = (Object.keys(STAGES) as Stage[]).find((k) => STAGES[k].includes(r.status))
    if (st) setStage(st)
    setOpenId(r.id)
    setScan('')
  }

  if (list.isLoading) return <Spinner label="Loading worklist…" />
  if (list.error) return <ErrorBox error={list.error} />
  const c = list.data!.counts
  const count = (s: Stage) => STAGES[s].reduce((n, k) => n + (c[k] ?? 0), 0)
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const selectedPatients = new Set(selectedRows.map((r) => r.patient.id))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile icon="TestTube" label="To collect" value={count('collect')} onClick={() => setStage('collect')} />
        <StatTile icon="FlaskConical" label="In lab" value={count('lab')} onClick={() => setStage('lab')} />
        <StatTile icon="ShieldCheck" label="Awaiting authorisation" value={count('verify')} onClick={() => setStage('verify')} />
        <StatTile icon="CircleCheck" label="Completed today" value={count('done')} onClick={() => setStage('done')} />
        <StatTile icon="Siren" label="STAT pending" value={list.data!.stat} tone={list.data!.stat ? 'alert' : 'default'} />
        <StatTile icon="Timer" label="Past TAT" value={list.data!.overdue} tone={list.data!.overdue ? 'alert' : 'default'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <div className="relative w-full sm:w-80">
          <ScanBarcode className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input ref={scanRef} autoFocus value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onScan() } }}
            className="pl-8 font-mono" placeholder="Scan barcode / order no. / UHID, Enter" aria-label="Scan or search" />
        </div>
        <Select value={section} onChange={(e) => setSection(e.target.value)} className="max-w-56 shrink-0" aria-label="Section">
          <option value="">All sections</option>
          {list.data!.sections.map((s) => <option key={s}>{s}</option>)}
        </Select>
        {stage === 'collect' && canCollect && selected.size > 0 && (
          <Button variant="primary" icon="TestTube" loading={collect.isPending} disabled={selectedPatients.size > 1}
            title={selectedPatients.size > 1 ? 'Select tests for one patient at a time' : undefined} onClick={() => collect.mutate([...selected])}>
            Collect {selected.size} & print label{selected.size > 1 ? 's' : ''}
          </Button>
        )}
        <span className="ml-auto text-xs text-ink-3">Live · {time(list.data!.generated_at)}</span>
      </div>

      <Tabs value={stage} onChange={setStage} tabs={(Object.keys(STAGES) as Stage[]).map((s) => ({ key: s, label: STAGE_LABEL[s], count: count(s) }))} />

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>
                {stage === 'collect' && canCollect && <th className="w-8 px-3 py-2"><span className="sr-only">Select</span></th>}
                {['Priority', 'Order / barcode', 'Patient', 'Test', 'Sample', stage === 'done' ? 'Verified' : 'Ordered', 'TAT', 'Status', ''].map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)}
                  className={cn('cursor-pointer border-b border-line last:border-0 hover:bg-surface-2',
                    r.overdue && r.status !== 'Verified' && 'bg-red-50/60 dark:bg-red-500/5', r.critical && 'bg-red-50 dark:bg-red-500/10')}>
                  {stage === 'collect' && canCollect && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="size-4 accent-brand-700" aria-label={`Select ${r.code}`} checked={selected.has(r.id)}
                        onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })} />
                    </td>
                  )}
                  <td className="px-3 py-2"><PriorityBadge priority={r.priority} /></td>
                  <td className="whitespace-nowrap px-3 py-2"><div className="font-mono text-xs text-ink">{r.code}</div>{r.sample_barcode && <div className="font-mono text-xs text-ink-3">{r.sample_barcode}</div>}</td>
                  <td className="max-w-56 px-3 py-2"><PatientCell p={r.patient} location={r.location} /></td>
                  <td className="px-3 py-2"><div className="text-ink">{r.test.name}</div><div className="text-xs text-ink-3">{r.test.section}</div></td>
                  <td className="px-3 py-2 text-xs text-ink-2">{r.test.sample_type ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{stage === 'done' ? time(r.verified_at) : dateTime(r.ordered_at)}</td>
                  <td className="px-3 py-2"><TatCell r={r} /></td>
                  <td className="px-3 py-2"><span className="flex items-center gap-1"><StatusBadge status={r.status} />{r.critical && <Badge tone="red">Critical</Badge>}</span></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {r.status === 'Ordered' && canCollect && <Button size="xs" variant="primary" loading={collect.isPending && collect.variables?.[0] === r.id} onClick={() => collect.mutate([r.id])}>Collect</Button>}
                    {r.status === 'Collected' && isLab && <Button size="xs" loading={receive.isPending && receive.variables === r.id} onClick={() => receive.mutate(r.id)}>Receive</Button>}
                    {r.status === 'In Progress' && isLab && <Button size="xs" variant="primary" onClick={() => setOpenId(r.id)}>Enter results</Button>}
                    {r.status === 'Resulted' && <Button size="xs" variant="success" onClick={() => setOpenId(r.id)}>Review</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Empty icon="TestTubes" title={term ? 'No orders match the scan / search' : `Nothing ${STAGE_LABEL[stage].toLowerCase()}`} />}
      </div>

      {openId && <LabOrderDrawer id={openId} onClose={() => { setOpenId(null); scanRef.current?.focus() }} onLabels={setLabels} />}
      {labels && <LabelPrint labels={labels} onClose={() => setLabels(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ order drawer: collect / receive / results / verify

function LabOrderDrawer({ id, onClose, onLabels }: { id: string; onClose: () => void; onLabels: (l: Label[]) => void }) {
  const qc = useQueryClient()
  const [amend, setAmend] = useState(false)
  const [reject, setReject] = useState('')
  const q = useQuery({ queryKey: ['x', 'orders', 'detail', id], queryFn: () => api<OrderDetail>(`/orders/${id}/detail`) })
  const o = q.data
  const done = (msg: string) => { toast.success(msg); qc.invalidateQueries({ queryKey: ['x', 'orders'] }); setAmend(false) }
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<OrderDetail | { labels: Label[] }>(`/orders/${id}/${path}`, { method: 'POST', body }),
    onSuccess: (r, v) => {
      if ('labels' in r) { onLabels(r.labels); done('Sample collected') }
      else done(v.path === 'verify' ? 'Report authorised' : v.path === 'receive' ? 'Sample received' : v.path === 'reject-sample' ? 'Sample rejected — sent back for recollection' : 'Saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const can = (a: string) => !!o?.actions.includes(a)

  return (
    <Drawer open onClose={onClose} width="max-w-3xl"
      title={o ? <span className="flex items-center gap-2">{o.test.name} <StatusBadge status={o.status} />{o.critical && <Badge tone="red">Critical</Badge>}</span> : 'Order'}
      subtitle={o && <span className="font-mono text-xs">{o.code}{o.sample_barcode && ` · ${o.sample_barcode}`} · {o.priority}</span>}
      footer={o && (
        <>
          {can('collect') && <Button variant="primary" icon="TestTube" loading={act.isPending} onClick={() => act.mutate({ path: 'collect' })}>Collect & print label</Button>}
          {can('receive') && <Button icon="PackageCheck" loading={act.isPending} onClick={() => act.mutate({ path: 'receive' })}>Receive sample</Button>}
          {can('amend') && !amend && <Button icon="Pencil" onClick={() => setAmend(true)}>Correct values</Button>}
          {can('verify') && !amend && <Button variant="success" icon="ShieldCheck" loading={act.isPending} onClick={() => act.mutate({ path: 'verify', body: {} })}>Verify & authorise</Button>}
        </>
      )}>
      {q.isLoading && <Spinner />}
      {q.error && <div className="p-5"><ErrorBox error={q.error} /></div>}
      {o && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-surface-2 p-3">
            <PatientCell p={o.patient} location={o.location} />
            <div className="text-right text-xs text-ink-2">
              {o.ordering_doctor && <div>Ordered by {o.ordering_doctor}{o.verbal_order && ' (verbal)'}</div>}
              {o.clinical_notes && <div className="max-w-xs text-ink">Indication: {o.clinical_notes}</div>}
            </div>
          </div>
          <Timeline o={o} />
          <KeyValue cols={3} items={[
            { label: 'Sample', value: [o.test.sample_type, o.test.container].filter(Boolean).join(' · ') || '—' },
            { label: 'Section', value: o.test.section ?? '—' },
            { label: 'Tube', value: o.sample ? <span>{o.sample.code} <StatusBadge status={o.sample.status} /></span> : '—' },
          ]} />
          {o.critical && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
              Critical value — clinician alerted. {o.acknowledged_at ? `Acknowledged by ${o.acknowledged_by} at ${dateTime(o.acknowledged_at)}.` : 'Awaiting clinician acknowledgement; phone the ward and document read-back.'}
            </div>
          )}
          {(can('result') || amend) ? (
            <ResultEntry o={o} saving={act.isPending} onSave={(body) => act.mutate({ path: 'results', body })} onCancel={amend ? () => setAmend(false) : undefined} />
          ) : (
            <ResultView o={o} />
          )}
          {can('reject') && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <span className="text-sm text-ink-2">Sample unfit?</span>
              <Select value={reject} onChange={(e) => setReject(e.target.value)} className="max-w-56 shrink-0" aria-label="Rejection reason">
                <option value="">Choose reason…</option>
                {['Haemolysed', 'Clotted', 'Insufficient quantity', 'Wrong container', 'Unlabelled', 'Delayed transport'].map((x) => <option key={x}>{x}</option>)}
              </Select>
              <Button size="sm" variant="danger" disabled={!reject} loading={act.isPending} onClick={() => act.mutate({ path: 'reject-sample', body: { reason: reject } })}>Reject sample</Button>
            </div>
          )}
          {o.verified_by && <p className="text-xs text-ink-3">Authorised by {o.verified_by} · {dateTime(o.verified_at)}</p>}
        </div>
      )}
    </Drawer>
  )
}

function ResultEntry({ o, saving, onSave, onCancel }: {
  o: OrderDetail; saving: boolean; onSave: (body: { values: { parameter: string; value: string }[]; result?: string; impression?: string }) => void; onCancel?: () => void
}) {
  const initial = useMemo(() => {
    const existing = new Map(o.result_values.map((v) => [v.parameter.toLowerCase(), v.value ?? '']))
    const fromParams = o.parameters.map((p) => ({ parameter: p.parameter, value: existing.get(p.parameter.toLowerCase()) ?? '' }))
    const extras = o.result_values.filter((v) => !o.parameters.some((p) => p.parameter.toLowerCase() === v.parameter.toLowerCase()))
      .map((v) => ({ parameter: v.parameter, value: v.value ?? '' }))
    const rows = [...fromParams, ...extras]
    return rows.length ? rows : [{ parameter: '', value: '' }]
  }, [o])
  const [rows, setRows] = useState(initial)
  const [result, setResult] = useState(o.result ?? '')
  const [impression, setImpression] = useState(o.impression ?? '')
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const params = useMemo(() => new Map(o.parameters.map((p) => [p.parameter.toLowerCase(), p])), [o.parameters])
  const flags = rows.map((r) => liveFlag(r.value, params.get(r.parameter.toLowerCase())))
  const criticalCount = flags.filter((f) => f?.startsWith('Critical')).length
  const filled = rows.filter((r) => r.parameter.trim() && r.value.trim())

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['Parameter', 'Result', 'Unit', 'Reference', 'Flag'].map((h) => <th key={h} className="px-3 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const p = params.get(r.parameter.toLowerCase())
              return (
                <tr key={i} className={cn('border-t border-line', flags[i]?.startsWith('Critical') && 'bg-red-50 dark:bg-red-500/10')}>
                  <td className="px-3 py-1">
                    {p ? <span className="text-ink">{r.parameter}</span> : (
                      <Input className="h-8" value={r.parameter} placeholder="Parameter" aria-label="Parameter"
                        onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, parameter: e.target.value } : x)))} />
                    )}
                  </td>
                  <td className="w-40 px-3 py-1">
                    <Input ref={(el) => { inputs.current[i] = el }} className={cn('h-8 tabular', flags[i] && flags[i] !== 'Normal' && 'border-red-400 font-semibold text-red-700 dark:text-red-300')}
                      value={r.value} aria-label={`Result for ${r.parameter || 'parameter'}`} autoFocus={i === 0}
                      onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); inputs.current[i + 1]?.focus() } }} />
                  </td>
                  <td className="px-3 py-1 text-ink-2">{p?.unit ?? ''}</td>
                  <td className="px-3 py-1 text-ink-2">{p?.ref_range ?? '—'}</td>
                  <td className="px-3 py-1"><FlagBadge flag={flags[i]} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {o.parameters.length === 0 && (
        <Button size="xs" variant="ghost" icon="Plus" onClick={() => setRows((cur) => [...cur, { parameter: '', value: '' }])}>Add parameter</Button>
      )}
      {criticalCount > 0 && (
        <p className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white">
          {criticalCount} critical value{criticalCount > 1 ? 's' : ''} — saving alerts the treating team immediately.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Comments / report"><Textarea rows={3} value={result} onChange={(e) => setResult(e.target.value)} placeholder="e.g. Peripheral smear: no abnormal cells" /></FieldWrap>
        <FieldWrap label="Impression"><Textarea rows={3} value={impression} onChange={(e) => setImpression(e.target.value)} /></FieldWrap>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button variant="primary" icon="Save" loading={saving} disabled={!filled.length && !result.trim()}
          onClick={() => onSave({ values: filled.map((r) => ({ parameter: r.parameter.trim(), value: r.value.trim() })), result: result || undefined, impression: impression || undefined })}>
          Save results{onCancel ? ' (corrected)' : ''}
        </Button>
      </div>
    </div>
  )
}

