import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, Printer, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
  Badge, Button, cn, CopyButton, Empty, ErrorBox, FieldWrap, Input, MenuItem, Modal, Popover, Segmented, Select, Spinner, Textarea,
} from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { api, errorMessage } from '@/lib/api'
import { dateTime, todayISO } from '@/lib/format'
import { Icon } from '@/lib/icons'
import {
  ExternalReportLink, MicroTable, NoSelection, PatientContext, PRINT_FORMATS, PrintJob, ResultTable, TrendPanel, type PrintFormat,
} from './reportview'
import { Kpi, LabShell, useLabAccess } from './shell'
import type { Report, ReportView } from './types'

interface ListReport { id: string; code: string; test: string; section?: string | null; verified_at?: string | null; ordered_at?: string | null
  doctor?: string | null; critical: boolean; abnormal: number; print_count: number; status: string; verified_by?: string | null }
interface ListPatient { patient: { id: string; name: string; uhid?: string | null; gender?: string | null; age?: string | null }
  patient_type: 'IP' | 'OP' | 'ER'; ip_no?: string | null; ward?: string | null; bed?: string | null; reports: ListReport[] }
interface ListRes { patients: ListPatient[]; page: number; pages: number; total_patients: number; sections: string[]; from: string; to: string
  kpis: { reports: number; patients: number; in_patients: number; out_patients: number; er: number } }

type PType = 'all' | 'OP' | 'IP' | 'ER'
const STATUS = [['all', 'All statuses'], ['released', 'Released (not printed)'], ['printed', 'Printed'], ['abnormal', 'Has abnormal values'], ['critical', 'Critical']] as const

function readSplit(): number {
  try { return Number(localStorage.getItem('w7.lab.split')) || 38 } catch { return 38 }
}

export default function AuthorizedReports() {
  const acc = useLabAccess()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 350)
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [ptype, setPtype] = useState<PType>('all')
  const [status, setStatus] = useState<string>('all')
  const [section, setSection] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string[]>([])
  const [split, setSplit] = useState(readSplit)
  const [printing, setPrinting] = useState<{ ids: string[]; format: PrintFormat } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => { setPage(1) }, [dq, from, to, ptype, status, section])
  const list = useQuery({
    queryKey: ['x', 'lab', 'authorized', { dq, from, to, ptype, status, section, page }],
    queryFn: () => api<ListRes>('/lab/authorized', { query: { q: dq || undefined, date_from: from, date_to: to, patient_type: ptype, status, section: section || undefined, page } }),
    placeholderData: (p) => p,
    enabled: acc.reports,
  })
  const view = useQuery({
    queryKey: ['x', 'lab', 'authorized-view', selected],
    queryFn: () => api<ReportView>('/lab/authorized/view', { query: { ids: selected.join(',') } }),
    enabled: selected.length > 0,
    placeholderData: (p) => (selected.length ? p : undefined),
  })

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const toggle = (ids: string[], on: boolean) => setSelected((cur) => on ? [...cur, ...ids.filter((i) => !cur.includes(i))] : cur.filter((i) => !ids.includes(i)))
  const record = useMutation({
    mutationFn: (b: { order_ids: string[]; format: PrintFormat }) => api('/lab/authorized/print', { method: 'POST', body: b }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['x', 'lab'] }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const print = (ids: string[], format: PrintFormat) => {
    if (!view.data) return
    record.mutate({ order_ids: ids, format })
    setPrinting({ ids, format })
  }
  const donePrinting = useCallback(() => setPrinting(null), [])

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const move = (ev: MouseEvent) => {
      const r = box.current?.getBoundingClientRect()
      if (!r) return
      const pct = Math.min(60, Math.max(26, ((ev.clientX - r.left) / r.width) * 100))
      setSplit(pct)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setSplit((v) => { try { localStorage.setItem('w7.lab.split', String(Math.round(v))) } catch { /* ignore */ } return v })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const k = list.data?.kpis
  const patients = list.data?.patients ?? []
  const allOnPage = patients.flatMap((p) => p.reports.map((r) => r.id))

  return (
    <LabShell screen="authorized" icon="FileCheck2" title="Authorised reports"
      subtitle="Tick a patient's tests to view, print (with or without letterhead, or as a smart report with trends) or roll them back."
      actions={k && (
        <div className="flex flex-wrap gap-2">
          <Kpi icon="FlaskConical" label="Reports" value={k.reports} />
          <Kpi icon="Users" label="Patients (page)" value={k.patients} />
          <Kpi icon="BedDouble" label="In-patients (page)" value={k.in_patients} />
          <Kpi icon="Stethoscope" label="Out-patients (page)" value={k.out_patients} />
        </div>
      )}>
      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-2.5">
        <FieldWrap label="Search" className="min-w-64 flex-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" aria-label="Search reports"
              placeholder="Bill no / IP no / ward / bed / order no / barcode / UHID / patient / mobile   ( / )" />
          </div>
        </FieldWrap>
        <FieldWrap label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="Patient">
          <Segmented value={ptype} onChange={setPtype} options={[{ key: 'all', label: 'All' }, { key: 'OP', label: 'Out-patient' }, { key: 'IP', label: 'In-patient' }, { key: 'ER', label: 'ER' }]} />
        </FieldWrap>
        <FieldWrap label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">{STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </FieldWrap>
        <FieldWrap label="Department">
          <Select value={section} onChange={(e) => setSection(e.target.value)} className="w-44">
            <option value="">All departments</option>{(list.data?.sections ?? []).map((s) => <option key={s}>{s}</option>)}
          </Select>
        </FieldWrap>
        <Button variant="ghost" aria-label="Refresh" title="Refresh" onClick={() => list.refetch()} className="px-2.5"><RefreshCw className={cn('size-4', list.isFetching && 'animate-spin')} /></Button>
      </div>

      <div ref={box} className="flex flex-col gap-3 lg:flex-row lg:gap-0">
        {/* ------------------------------------------------------------ patients */}
        <section className="flex min-h-[60vh] flex-col rounded-xl border border-line bg-surface lg:min-w-0" style={{ flexBasis: `${split}%` }}>
          <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold text-ink">Patients</h2>
            {allOnPage.length > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-ink-2">
                <input type="checkbox" className="size-4 accent-brand-700" checked={allOnPage.every((i) => selected.includes(i))}
                  onChange={(e) => toggle(allOnPage, e.target.checked)} /> All on page
              </label>
            )}
          </header>
          <div className="flex-1 overflow-y-auto p-2 scroll-thin lg:max-h-[calc(100vh-300px)]">
            {list.isLoading && <Spinner />}
            {list.error && <ErrorBox error={list.error} />}
            {list.data && patients.length === 0 && <Empty icon="FileSearch" title="No authorised reports">Change the dates, patient type or search.</Empty>}
            <ul className="space-y-1.5">
              {patients.map((p) => {
                const ids = p.reports.map((r) => r.id)
                const all = ids.every((i) => selected.includes(i))
                const some = !all && ids.some((i) => selected.includes(i))
                const isOpen = open.has(p.patient.id) || some || all
                return (
                  <li key={p.patient.id} className="rounded-lg border border-line">
                    <div className="flex items-start gap-2 px-2.5 py-2">
                      <input type="checkbox" className="mt-1 size-4 accent-brand-700" aria-label={`Select all reports of ${p.patient.name}`} checked={all}
                        ref={(el) => { if (el) el.indeterminate = some }} onChange={(e) => toggle(ids, e.target.checked)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link to={`/patients/${p.patient.id}`} className="truncate font-medium text-ink hover:underline">{p.patient.name}</Link>
                          <Badge tone="blue">{p.patient.age} · {p.patient.gender?.[0]}</Badge>
                          <span className="text-xs text-ink-3">{p.reports.length} report{p.reports.length > 1 ? 's' : ''}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-ink-2">UHID {p.patient.uhid}<CopyButton value={p.patient.uhid} label="Copy UHID" /></span>
                          {p.ip_no && <span className="inline-flex items-center gap-0.5 rounded bg-violet-50 px-1.5 py-0.5 font-mono text-violet-800 dark:bg-violet-500/10 dark:text-violet-300">IP {p.ip_no}<CopyButton value={p.ip_no} label="Copy IP no" /></span>}
                          {p.ward && <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"><Icon name="BedDouble" className="size-3" />{p.ward} · {p.bed}</span>}
                          {p.patient_type === 'ER' && <Badge tone="red">ER</Badge>}
                        </div>
                      </div>
                      <button className="rounded p-1 text-ink-3 hover:bg-surface-2" aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen}
                        onClick={() => setOpen((cur) => { const n = new Set(cur); if (n.has(p.patient.id)) n.delete(p.patient.id); else n.add(p.patient.id); return n })}>
                        <ChevronDown className={cn('size-4 transition-transform', isOpen && 'rotate-180')} />
                      </button>
                    </div>
                    {isOpen && (
                      <ul className="border-t border-line">
                        {p.reports.map((r) => (
                          <li key={r.id}>
                            <label className="flex cursor-pointer items-start gap-2 px-2.5 py-1.5 hover:bg-surface-2">
                              <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={selected.includes(r.id)} onChange={(e) => toggle([r.id], e.target.checked)} />
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium uppercase text-ink">{r.test}</span>
                                <span className="block truncate text-[11px] text-ink-3">
                                  Order <span className="font-mono">{r.code}</span> · {r.section ?? '—'}{r.doctor ? ` · ${r.doctor}` : ''} · {dateTime(r.verified_at)}
                                </span>
                              </span>
                              <span className="flex shrink-0 flex-col items-end gap-0.5">
                                <Badge tone="green">Released</Badge>
                                {r.critical ? <Badge tone="red">Critical</Badge> : r.abnormal > 0 ? <Badge tone="amber">{r.abnormal} abnormal</Badge> : null}
                                {r.print_count > 0 && <span className="text-[10px] text-ink-3">Printed ×{r.print_count}</span>}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-line px-3 py-1.5 text-xs text-ink-2">
            {list.data && <span>{list.data.page} of {list.data.pages} ({list.data.kpis.reports} reports)</span>}
            <Button size="xs" variant="ghost" aria-label="Previous page" disabled={!list.data || page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" /></Button>
            <Button size="xs" variant="ghost" aria-label="Next page" disabled={!list.data || page >= list.data.pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="size-4" /></Button>
          </footer>
        </section>

        <div role="separator" aria-orientation="vertical" aria-label="Resize panes" onMouseDown={startDrag}
          className="mx-1 hidden w-2 shrink-0 cursor-col-resize items-center justify-center lg:flex">
          <span className="h-10 w-1 rounded-full bg-line-2" />
        </div>

        {/* ------------------------------------------------------------ report viewer */}
        <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col rounded-xl border border-line bg-surface">
          <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold text-ink">Reports{selected.length > 0 && ` (${selected.length} selected)`}</h2>
            <div className="flex items-center gap-2">
              {selected.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>}
              <PrintMenu count={selected.length} disabled={!view.data || !selected.length} onPrint={(f) => print(selected, f)} />
            </div>
          </header>
          <div className="flex-1 overflow-y-auto p-3 scroll-thin lg:max-h-[calc(100vh-300px)]">
            {!selected.length && <NoSelection />}
            {selected.length > 0 && view.isLoading && <Spinner label="Loading reports…" />}
            {view.error && <ErrorBox error={view.error} />}
            {selected.length > 0 && view.data && (
              <div className="space-y-4">
                {view.data.groups.map((g) => (
                  <div key={g.patient.id} className="space-y-3">
                    <PatientContext g={g} />
                    {g.reports.map((r) => <ReportCard key={r.id} r={r} canRollback={acc.rollback} onPrint={(f) => print([r.id], f)} />)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      {printing && view.data && <PrintJob view={view.data} ids={printing.ids} format={printing.format} onDone={donePrinting} />}
    </LabShell>
  )
}

function PrintMenu({ count, disabled, onPrint, size = 'sm' }: { count: number; disabled?: boolean; onPrint: (f: PrintFormat) => void; size?: 'xs' | 'sm' }) {
  return (
    <Popover trigger={({ toggle }) => (
      <Button size={size} variant="primary" disabled={disabled} onClick={toggle} aria-haspopup="menu">
        <Printer className="size-4" />Print{count ? ` (${count})` : ''}<ChevronDown className="size-3.5" />
      </Button>
    )}>
      {(close) => PRINT_FORMATS.map((f) => (
        <MenuItem key={f.key} icon={f.icon} hint={f.hint} onClick={() => { close(); onPrint(f.key) }}>{f.label}</MenuItem>
      ))}
    </Popover>
  )
}

function ReportCard({ r, canRollback, onPrint }: { r: Report; canRollback: boolean; onPrint: (f: PrintFormat) => void }) {
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [trend, setTrend] = useState(false)
  const [rollback, setRollback] = useState(false)
  const hasRows = r.rows.length > 0
  return (
    <article className="rounded-xl border border-line">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase text-brand-800 dark:text-brand-300">{r.test} <span className="font-normal normal-case text-ink-2">· {r.section}</span></div>
          <div className="text-xs text-ink-3"><span className="font-mono">{r.code}</span>{r.barcode && <> · tube <span className="font-mono">{r.barcode}</span></>} · {r.sample_type}</div>
          <div className="text-xs text-ink-3">Entered by {r.resulted_by ?? '—'} · {dateTime(r.resulted_at)} · authorised by {r.verified_by ?? '—'} · {dateTime(r.verified_at)}</div>
        </div>
        <div className="flex items-center gap-2">
          <PrintMenu size="xs" count={1} onPrint={onPrint} />
          <Badge tone="green">Released</Badge>
          {r.print_count > 0 && <Badge tone="gray">Printed ×{r.print_count}</Badge>}
        </div>
      </header>
      <div className="space-y-3 p-3">
        {r.critical && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
            Critical value{r.acknowledged_by ? ` — acknowledged by ${r.acknowledged_by}` : ' — awaiting clinician acknowledgement'}.
          </p>
        )}
        {hasRows && !r.micro && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {r.abnormal > 0 ? <Badge tone="amber">{r.abnormal} abnormal</Badge> : <Badge tone="green">All within range</Badge>}
              {r.amended_at && <Badge tone="violet">Corrected {dateTime(r.amended_at)}</Badge>}
            </div>
            <div className="flex items-center gap-3">
              <Button size="xs" variant={trend ? 'primary' : 'secondary'} icon="TrendingUp" onClick={() => setTrend((v) => !v)} aria-pressed={trend}>Compare previous results</Button>
              <label className="flex items-center gap-1.5 text-xs text-ink-2">
                <input type="checkbox" className="size-4 accent-brand-700" checked={abnormalOnly} onChange={(e) => setAbnormalOnly(e.target.checked)} disabled={!r.abnormal} />
                Abnormal only ({r.abnormal})
              </label>
            </div>
          </div>
        )}
        {trend && <TrendPanel orderId={r.id} />}
        {r.micro ? <MicroTable m={r.micro} /> : <ResultTable rows={r.rows} abnormalOnly={abnormalOnly} />}
        {r.result && !r.micro && <div><h4 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Report</h4><p className="whitespace-pre-wrap text-sm text-ink">{r.result}</p></div>}
        {r.impression && <div><h4 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Impression</h4><p className="text-sm font-medium text-ink">{r.impression}</p></div>}
        {r.interpretation && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2"><b>Interpretation:</b> {r.interpretation}</p>}
        {r.outsourced && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
            <span>Performed at {r.outsourced.lab}{r.outsourced.external_ref && ` (ref. ${r.outsourced.external_ref})`}</span>
            {r.outsourced.report_file && <ExternalReportLink fileId={r.outsourced.report_file} />}
          </div>
        )}
        {r.rollbacks.length > 0 && (
          <details className="text-xs text-ink-2">
            <summary className="cursor-pointer">Authorisation history ({r.rollbacks.length} roll-back{r.rollbacks.length > 1 ? 's' : ''})</summary>
            <ul className="mt-1 space-y-0.5">{r.rollbacks.map((b, i) => <li key={i}>{dateTime(b.at)} · {b.by}: {b.reason}</li>)}</ul>
          </details>
        )}
        {canRollback && (
          <div className="flex justify-end border-t border-line pt-2">
            <Button size="xs" variant="ghost" icon="Undo2" className="text-red-700 dark:text-red-300" onClick={() => setRollback(true)}>Roll back authorisation</Button>
          </div>
        )}
      </div>
      {rollback && <RollbackDialog r={r} onClose={() => setRollback(false)} />}
    </article>
  )
}

function RollbackDialog({ r, onClose }: { r: Report; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: () => api(`/lab/authorized/${r.id}/rollback`, { method: 'POST', body: { reason } }),
    onSuccess: () => { toast.success(`${r.code} rolled back to “Resulted” — correct and re-authorise it on the worksheet`); qc.invalidateQueries({ queryKey: ['x', 'lab'] }); qc.invalidateQueries({ queryKey: ['x', 'orders'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const ok = reason.trim().length >= 5
  return (
    <Modal open onClose={onClose} title={`Roll back ${r.test}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Keep released</Button><Button variant="danger" disabled={!ok} loading={m.isPending} onClick={() => m.mutate()}>Roll back</Button></>}>
      <p className="mb-3 text-sm text-ink-2">
        The report is withdrawn from the wards and the result inbox and returns to <b>Resulted</b> with its values, for correction and re-authorisation.
        {r.print_count > 0 && <> It has been printed {r.print_count} time{r.print_count > 1 ? 's' : ''} — retrieve the printed copies.</>} The reason is kept in the audit trail.
      </p>
      <FieldWrap label="Reason" required help="At least 5 characters">
        <Textarea rows={3} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Value transcribed from the wrong tube; re-run ordered" />
      </FieldWrap>
    </Modal>
  )
}
