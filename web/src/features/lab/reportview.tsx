import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Badge, cn, CopyButton, Empty, ErrorBox, Spinner } from '@/components/ui'
import { api, apiUrl } from '@/lib/api'
import { date, dateTime, minutes } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { Barcode } from './labels'
import { PATIENT_TYPE_LABEL, type MicroReport, type Report, type ReportGroup, type ReportRow, type ReportView } from './types'

export type PrintFormat = 'letterhead' | 'plain' | 'smart'
export const PRINT_FORMATS: { key: PrintFormat; label: string; hint: string; icon: string }[] = [
  { key: 'letterhead', label: 'With letterhead', hint: 'Hospital header and footer', icon: 'FileText' },
  { key: 'plain', label: 'Without letterhead', hint: 'For pre-printed stationery', icon: 'File' },
  { key: 'smart', label: 'Smart report', hint: 'Abnormal summary and trends', icon: 'TrendingUp' },
]

export interface TrendSeries { parameter: string; unit?: string | null; ref_range?: string | null; points: { at?: string | null; code: string; value?: string | null; numeric?: number | null; flag?: string | null; current: boolean }[] }
export interface Trend { order_id: string; results: number; series: TrendSeries[] }

const FLAG_TONE = (flag?: string | null) => (!flag || flag === 'Normal' ? '' : flag.startsWith('Critical') ? 'critical' : flag === 'Low' ? 'low' : 'high')

function rangeOf(s?: string | null): [number | null, number | null] {
  const m = (s ?? '').match(/(-?[\d.]+)\s*[–-]\s*(-?[\d.]+)/)
  if (m) return [Number(m[1]), Number(m[2])]
  const lt = (s ?? '').match(/<\s*(-?[\d.]+)/)
  if (lt) return [null, Number(lt[1])]
  const gt = (s ?? '').match(/>\s*(-?[\d.]+)/)
  return gt ? [Number(gt[1]), null] : [null, null]
}

/** Inline trend with the reference band shaded; works on screen and on paper. */
export function Sparkline({ s, width = 140, height = 34, print }: { s: TrendSeries; width?: number; height?: number; print?: boolean }) {
  const pts = s.points.filter((p) => p.numeric != null)
  if (pts.length < 2) return <span className="text-xs text-ink-3">{pts.length === 1 ? 'First result' : '—'}</span>
  const [lo, hi] = rangeOf(s.ref_range)
  const vals = [...pts.map((p) => p.numeric as number), ...(lo != null ? [lo] : []), ...(hi != null ? [hi] : [])]
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const pad = (max - min) * 0.12 || 1
  const y = (v: number) => height - 3 - ((v - (min - pad)) / (max - min + pad * 2)) * (height - 6)
  const x = (i: number) => 4 + (i / (pts.length - 1)) * (width - 8)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.numeric as number).toFixed(1)}`).join(' ')
  const stroke = print ? '#1f4e9b' : 'var(--s1)'
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${s.parameter} trend: ${pts.map((p) => p.value).join(', ')}`}>
      {lo != null && hi != null && <rect x={0} width={width} y={y(hi)} height={Math.max(1, y(lo) - y(hi))} fill={print ? '#e6f4ea' : 'var(--grid)'} opacity={print ? 1 : 0.9} />}
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.6} />
      {pts.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.numeric as number)} r={p.current ? 3 : 2.2}
          fill={FLAG_TONE(p.flag) ? (print ? '#c0392b' : '#dc2626') : stroke} stroke={print ? '#fff' : 'var(--surface)'} strokeWidth={1} />
      ))}
    </svg>
  )
}

export function useTrend(orderId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['x', 'lab', 'trend', orderId],
    queryFn: () => api<Trend>('/lab/authorized/trend', { query: { order_id: orderId } }),
    enabled: !!orderId && enabled,
    staleTime: 60_000,
  })
}

export function FlagMark({ code, flag }: { code?: string | null; flag?: string | null }) {
  if (!code) return null
  const t = FLAG_TONE(flag)
  return (
    <span className={cn('ml-1 inline-grid min-w-4 place-items-center rounded px-0.5 text-[10px] font-bold',
      t === 'low' ? 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300'
        : t === 'critical' ? 'bg-red-600 text-white' : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300')}
      title={flag ?? undefined}>{code}</span>
  )
}

/** S / I / R table for a culture report. */
export function MicroTable({ m, print }: { m: MicroReport; print?: boolean }) {
  if (m.culture_result !== 'Growth' || !m.organisms.length) {
    return <p className={print ? '' : 'text-sm text-ink'}><b>Culture:</b> {m.culture_result}{m.incubation_hours ? ` after ${m.incubation_hours} h incubation` : ''}</p>
  }
  const abx = [...new Set(m.organisms.flatMap((o) => o.sensitivity.map((s) => s.antibiotic)))]
  const cell = print ? 'border border-slate-300 px-1.5 py-0.5' : 'border-t border-line px-2 py-1'
  return (
    <div className="space-y-2">
      <p className={print ? '' : 'text-sm text-ink'}>
        {m.specimen && <><b>Specimen:</b> {m.specimen}. </>}{m.gram_stain && <><b>Gram stain:</b> {m.gram_stain}. </>}
        <b>Culture:</b> growth{m.incubation_hours ? ` after ${m.incubation_hours} h` : ''}.
      </p>
      <table className={cn('w-full text-xs', !print && 'overflow-hidden rounded-lg border border-line')}>
        <thead className={print ? '' : 'bg-surface-2 text-ink-2'}>
          <tr><th className={cn(cell, 'text-left')}>Antibiotic</th>{m.organisms.map((o, i) => (
            <th key={i} className={cn(cell, 'text-left')}>{o.organism}{o.colony_count ? ` (${o.colony_count})` : ''}{o.resistance.length ? ` · ${o.resistance.join(', ')}` : ''}</th>
          ))}</tr>
        </thead>
        <tbody>
          {abx.map((a) => (
            <tr key={a}>
              <td className={cell}>{a}</td>
              {m.organisms.map((o, i) => {
                const s = o.sensitivity.find((x) => x.antibiotic === a)
                return (
                  <td key={i} className={cn(cell, 'font-semibold', s?.interpretation === 'R' ? 'text-red-700' : s?.interpretation === 'I' ? 'text-amber-700' : 'text-emerald-700')}>
                    {s ? `${s.interpretation === 'S' ? 'Sensitive' : s.interpretation === 'I' ? 'Intermediate' : 'Resistant'}${s.mic ? ` · MIC ${s.mic}` : ''}` : '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {m.comments && <p className={print ? '' : 'text-sm text-ink'}><b>Comments:</b> {m.comments}</p>}
    </div>
  )
}

// ================================================================== on-screen report card

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
      <div className="truncate text-sm text-ink">{value || '—'}</div>
    </div>
  )
}

export function PatientContext({ g, compact }: { g: ReportGroup; compact?: boolean }) {
  const e = g.encounter
  const r0 = g.reports[0]
  return (
    <div className={cn('rounded-xl border border-line bg-surface-2/60 p-3', compact && 'p-2.5')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="User" className="size-4 text-ink-3" />
        <span className="font-semibold text-ink">{g.patient.name}</span>
        <span className="text-xs text-ink-2">{g.patient.age} / {g.patient.gender}</span>
        <span className="font-mono text-xs text-ink-2">UHID {g.patient.uhid}</span><CopyButton value={g.patient.uhid} label="Copy UHID" />
        <Badge tone={g.patient_type === 'IP' ? 'violet' : g.patient_type === 'ER' ? 'red' : 'blue'}>{PATIENT_TYPE_LABEL[g.patient_type]}</Badge>
        {e.status && g.patient_type === 'IP' && <Badge tone={e.status === 'Admitted' ? 'green' : 'gray'}>{e.status}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label={g.patient_type === 'IP' ? 'IP no' : 'Visit no'} value={<span className="font-mono">{e.ip_no ?? e.visit_no}</span>} />
        <Field label="Ward / bed" value={e.ward ? `${e.ward} · ${e.bed ?? ''}` : null} />
        <Field label="Consultant" value={e.consultant ?? r0?.ordering_doctor} />
        <Field label={g.patient_type === 'IP' ? 'Admitted' : 'Department'} value={g.patient_type === 'IP' ? dateTime(e.admitted_at) : e.department} />
        {g.patient_type === 'IP' && <Field label="Department" value={e.department} />}
        <Field label="Ref. doctor" value={e.ref_doctor} />
        <Field label="Mobile" value={g.patient.phone} />
        <Field label="Ordered" value={dateTime(r0?.ordered_at)} />
        <Field label="Collected" value={dateTime(r0?.collected_at)} />
      </div>
    </div>
  )
}

export function ResultTable({ rows, abnormalOnly }: { rows: ReportRow[]; abnormalOnly?: boolean }) {
  const shown = abnormalOnly ? rows.filter((r) => r.abnormal) : rows
  if (!shown.length) return <p className="px-1 py-3 text-sm text-ink-3">{abnormalOnly ? 'No abnormal values.' : 'No result values.'}</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-surface-2 text-xs text-ink-2">
          <tr>{['S.No', 'Component', 'Result value', 'Interface value', 'Normal value', 'Method', 'Param note', 'Alarm'].map((h) => (
            <th key={h} className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const tone = FLAG_TONE(r.flag)
            return (
              <tr key={r.parameter + i} className={cn('border-t border-line', r.abnormal && 'bg-amber-50/70 dark:bg-amber-500/5', tone === 'critical' && 'bg-red-50 dark:bg-red-500/10')}>
                <td className="px-2.5 py-1.5 tabular text-ink-3">{i + 1}</td>
                <td className="px-2.5 py-1.5 font-medium text-ink">{r.parameter}</td>
                <td className={cn('whitespace-nowrap px-2.5 py-1.5 tabular font-semibold',
                  tone === 'low' ? 'text-sky-700 dark:text-sky-300' : tone ? 'text-red-700 dark:text-red-300' : 'text-ink')}>
                  {r.value ?? '—'}<FlagMark code={r.flag_code} flag={r.flag} />
                </td>
                <td className="px-2.5 py-1.5 tabular text-ink-2">{r.interface_value ?? '—'}</td>
                <td className="whitespace-nowrap px-2.5 py-1.5 text-ink-2">{r.normal ?? '—'}</td>
                <td className="px-2.5 py-1.5 text-xs text-ink-2">{r.method ?? '—'}</td>
                <td className="px-2.5 py-1.5 text-xs text-ink-2">{r.note ?? ''}</td>
                <td className="px-2.5 py-1.5">{r.alarm ? <Badge tone={r.alarm === 'Critical' ? 'red' : 'amber'}>{r.alarm}</Badge> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function TrendPanel({ orderId }: { orderId: string }) {
  const q = useTrend(orderId)
  if (q.isLoading) return <Spinner label="Loading previous results…" />
  if (q.error) return <ErrorBox error={q.error} />
  const t = q.data!
  if (t.results < 2) return <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">No earlier authorised result of this test for this patient.</p>
  const dates = t.series[0]?.points ?? []
  return (
    <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-xs text-ink-2">
          <tr>
            <th className="px-2.5 py-1.5 text-left font-medium">Parameter</th>
            <th className="px-2.5 py-1.5 text-left font-medium">Trend</th>
            {dates.map((p) => <th key={p.code} className="whitespace-nowrap px-2.5 py-1.5 text-right font-medium">{date(p.at)}{p.current && ' (this)'}</th>)}
          </tr>
        </thead>
        <tbody>
          {t.series.map((s) => (
            <tr key={s.parameter} className="border-t border-line">
              <td className="px-2.5 py-1.5 text-ink">{s.parameter}<div className="text-[11px] text-ink-3">{s.ref_range} {s.unit}</div></td>
              <td className="px-2.5 py-1"><Sparkline s={s} /></td>
              {dates.map((d) => {
                const p = s.points.find((x) => x.code === d.code)
                return <td key={d.code} className={cn('px-2.5 py-1.5 text-right tabular', FLAG_TONE(p?.flag) ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ink', p?.current && 'bg-brand-50/60 dark:bg-brand-500/10')}>{p?.value ?? '—'}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ================================================================== printing (A4; letterhead / plain / smart)

const PRINT_CSS = `
.w7-print { display: none; }
@media print {
  @page { size: A4; margin: 10mm 12mm; }
  body > *:not(.w7-print) { display: none !important; }
  .w7-print { display: block !important; color: #111; font: 10pt/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .w7-page { break-after: page; }
  .w7-page:last-child { break-after: auto; }
  .w7-print table { border-collapse: collapse; width: 100%; }
  .w7-print th, .w7-print td { text-align: left; vertical-align: top; }
}`

function PrintRows({ rows, smart, trend }: { rows: ReportRow[]; smart: boolean; trend?: Trend }) {
  const th = 'border-b border-slate-400 px-1.5 py-1 text-[9pt] font-semibold'
  const td = 'border-b border-slate-200 px-1.5 py-1'
  return (
    <table>
      <thead><tr>
        <th className={th}>Investigation</th><th className={th}>Result</th><th className={th}>Units</th><th className={th}>Biological ref. interval</th>
        <th className={th}>Method</th>{smart && <th className={th}>Trend</th>}
      </tr></thead>
      <tbody>
        {rows.map((r) => {
          const s = trend?.series.find((x) => x.parameter === r.parameter)
          return (
            <tr key={r.parameter}>
              <td className={td}>{r.parameter}{r.note ? <div className="text-[8pt] text-slate-500">{r.note}</div> : null}</td>
              <td className={cn(td, r.abnormal && 'font-bold')}>{r.value}{r.flag_code ? ` ${r.flag_code}` : ''}</td>
              <td className={td}>{r.unit ?? ''}</td>
              <td className={td}>{r.ref_range ?? ''}</td>
              <td className={cn(td, 'text-[8.5pt]')}>{r.method ?? ''}</td>
              {smart && <td className={td}>{s ? <Sparkline s={s} width={110} height={26} print /> : ''}</td>}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function PrintReport({ g, r, format, hospital, trend }: { g: ReportGroup; r: Report; format: PrintFormat; hospital: string; trend?: Trend }) {
  const e = g.encounter
  const smart = format === 'smart'
  const abnormal = r.rows.filter((x) => x.abnormal)
  const t = r.template
  return (
    <section className="w7-page">
      {format === 'plain' ? <div style={{ height: '32mm' }} /> : (
        <header className="mb-2 flex items-end justify-between border-b-2 border-slate-800 pb-2">
          <div>
            <div className="text-[15pt] font-bold tracking-tight">{hospital}</div>
            <div className="text-[9pt] text-slate-600">Department of Laboratory Medicine{t.header_note ? ` · ${t.header_note}` : ''}</div>
          </div>
          {r.barcode && <div className="w-[42mm] text-center text-[8pt]"><Barcode value={r.barcode} className="h-[8mm] w-full" /><div>{r.barcode}</div></div>}
        </header>
      )}
      <table className="mb-2 text-[9pt]">
        <tbody>
          <tr><td className="w-[18%] py-0.5 text-slate-500">Patient</td><td className="w-[32%] font-semibold">{g.patient.name}</td>
            <td className="w-[18%] text-slate-500">UHID</td><td className="font-mono">{g.patient.uhid}</td></tr>
          <tr><td className="py-0.5 text-slate-500">Age / sex</td><td>{g.patient.age} / {g.patient.gender}</td>
            <td className="text-slate-500">{g.patient_type === 'IP' ? 'IP no / bed' : 'Visit'}</td><td>{g.patient_type === 'IP' ? `${e.ip_no ?? ''} · ${e.ward ?? ''} ${e.bed ?? ''}` : PATIENT_TYPE_LABEL[g.patient_type]}</td></tr>
          <tr><td className="py-0.5 text-slate-500">Referred by</td><td>{r.ordering_doctor ?? e.consultant ?? e.ref_doctor ?? '—'}</td>
            <td className="text-slate-500">Order / sample</td><td className="font-mono">{r.code}{r.barcode ? ` · ${r.barcode}` : ''}</td></tr>
          <tr><td className="py-0.5 text-slate-500">Collected</td><td>{dateTime(r.collected_at)}</td>
            <td className="text-slate-500">Reported</td><td>{dateTime(r.verified_at)}</td></tr>
        </tbody>
      </table>
      <h2 className="mb-1 mt-3 border-y border-slate-300 py-1 text-center text-[11pt] font-bold uppercase tracking-wide">{r.section ? `${r.section} — ` : ''}{r.test}</h2>
      {smart && abnormal.length > 0 && (
        <div className="mb-2 rounded border border-amber-400 bg-amber-50 px-2 py-1.5 text-[9pt]">
          <b>{abnormal.length} result{abnormal.length > 1 ? 's' : ''} outside the reference interval:</b>{' '}
          {abnormal.map((x) => `${x.parameter} ${x.value}${x.unit ? ' ' + x.unit : ''} (${x.flag})`).join('; ')}
        </div>
      )}
      {r.micro ? <MicroTable m={r.micro} print /> : r.rows.length > 0 && <PrintRows rows={r.rows} smart={smart} trend={trend} />}
      {r.result && !r.micro && <p className="mt-2 whitespace-pre-wrap text-[9.5pt]">{r.result}</p>}
      {r.impression && <p className="mt-2 text-[9.5pt]"><b>Impression:</b> {r.impression}</p>}
      {r.interpretation && <p className="mt-2 whitespace-pre-wrap text-[8.5pt] text-slate-700"><b>Interpretation:</b> {r.interpretation}</p>}
      {smart && trend && trend.results > 1 && (
        <p className="mt-2 text-[8pt] text-slate-500">Trend shows the last {trend.results} authorised results of this test; the shaded band is the reference interval; red points are out of range.</p>
      )}
      {r.outsourced && <p className="mt-2 text-[8.5pt]">Test performed at {r.outsourced.lab}{r.outsourced.external_ref ? ` (ref. ${r.outsourced.external_ref})` : ''}.</p>}
      {r.critical && <p className="mt-2 text-[8.5pt] font-semibold">Critical value communicated{r.acknowledged_by ? ` — acknowledged by ${r.acknowledged_by}` : ''}.</p>}
      <div className="mt-8 flex items-end justify-between text-[9pt]">
        <div>{t.signatory_2_name ? <><div className="font-semibold">{t.signatory_2_name}</div><div className="text-slate-600">{t.signatory_2_designation}</div></> : <div className="text-slate-600">Entered by {r.resulted_by ?? '—'}</div>}</div>
        <div className="text-right">
          <div className="font-semibold">{t.signatory_1_name ?? r.verified_by ?? ''}</div>
          <div className="text-slate-600">{t.signatory_1_designation ?? `Authorised ${dateTime(r.verified_at)}`}</div>
        </div>
      </div>
      <footer className="mt-4 border-t border-slate-300 pt-1 text-[7.5pt] text-slate-500">
        {t.footer_text ?? 'Results relate only to the sample received. Please correlate clinically.'} · Printed {dateTime(new Date().toISOString())}
        {r.print_count > 0 ? ` · Duplicate copy (${r.print_count + 1})` : ''} · TAT {minutes(r.tat_minutes)}
      </footer>
    </section>
  )
}

/** Renders the chosen reports for the browser's print dialog, then closes itself. */
export function PrintJob({ view, ids, format, onDone }: { view: ReportView; ids: string[]; format: PrintFormat; onDone: () => void }) {
  const items = useMemo(() => view.groups.flatMap((g) => g.reports.filter((r) => ids.includes(r.id)).map((r) => ({ g, r }))), [view, ids])
  const trends = useQuery({
    queryKey: ['x', 'lab', 'print-trends', format, ids],
    queryFn: async () => Object.fromEntries(await Promise.all(items.map(async ({ r }) => [r.id, await api<Trend>('/lab/authorized/trend', { query: { order_id: r.id } })]))),
    enabled: format === 'smart',
  })
  const ready = format !== 'smart' || !!trends.data
  useEffect(() => {
    if (!ready) return
    const after = () => onDone()
    window.addEventListener('afterprint', after)
    const t = setTimeout(() => window.print(), 250)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after) }
  }, [ready, onDone])
  return (
    <>
      <style>{PRINT_CSS}</style>
      {createPortal(
        <div className="w7-print">
          {items.map(({ g, r }) => <Fragment key={r.id}><PrintReport g={g} r={r} format={format} hospital={view.hospital.name} trend={trends.data?.[r.id]} /></Fragment>)}
        </div>, document.body)}
      {!ready && <div className="no-print fixed inset-x-0 bottom-4 z-50 mx-auto w-fit rounded-lg bg-slate-900 px-3 py-2 text-sm text-white shadow-lg">Preparing smart report…</div>}
    </>
  )
}

export function ExternalReportLink({ fileId }: { fileId: string }) {
  return (
    <a href={apiUrl(`/files/${fileId}`, undefined, true)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-300">
      <Icon name="Paperclip" className="size-4" /> Reference lab report
    </a>
  )
}

export function NoSelection() {
  return <Empty icon="FileCheck2" title="Tick a patient's reports on the left to view and print them here." />
}

