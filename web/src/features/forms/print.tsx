/** Printable A4 layouts: a single form entry, the whole OT booklet and the intake/output chart. */
import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { Button, ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import { AnswerValue } from './fields'
import { BalanceView, type Balance } from './IoFlowsheet'
import { condOk, evaluate, isEmpty } from './logic'
import type { Booklet } from './OtBooklet'
import type { Entry, FormDef } from './types'

interface Header {
  name: string; uhid: string; gender?: string; age?: number | null; dob?: string; phone?: string; blood_group?: string
  admission: { code?: string; type?: string; location?: string; doctor_name?: string; started_at?: string; diagnosis?: string } | null
}

function useHeader(patientId?: string, encounterId?: string | null) {
  return useQuery({
    queryKey: ['forms-print-header', patientId, encounterId ?? ''],
    queryFn: () => api<Header>('/forms/patient-header', { query: { patient_id: patientId, encounter_id: encounterId ?? undefined } }),
    enabled: !!patientId,
  })
}

function useAutoPrint(ready: boolean) {
  const done = useRef(false)
  useEffect(() => {
    if (!ready || done.current) return
    done.current = true
    const t = window.setTimeout(() => window.print(), 500)
    return () => window.clearTimeout(t)
  }, [ready])
}

function Paper({ children }: { children: ReactNode }) {
  const meta = useMeta()
  return (
    <div className="min-h-full bg-slate-100 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] justify-end gap-2">
        <Button size="sm" icon="Printer" onClick={() => window.print()}>Print</Button>
        <Button size="sm" variant="ghost" onClick={() => window.close()}>Close</Button>
      </div>
      <article className="print-area mx-auto max-w-[210mm] bg-white p-8 text-[12px] leading-snug text-slate-900 shadow-lg print:p-0 print:shadow-none">
        <header className="mb-4 flex items-center justify-between border-b-2 border-slate-800 pb-2">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" className="size-9" alt="" />
            <div>
              <div className="text-base font-bold">{meta.data?.hospital.name}</div>
              <div className="text-[10px] text-slate-600">NABH accredited · 24×7 Emergency</div>
            </div>
          </div>
          <div className="text-right text-[10px] text-slate-600">Printed {dateTime(new Date().toISOString())}<br />by {meta.data?.user.name}</div>
        </header>
        {children}
        <footer className="mt-8 border-t border-slate-300 pt-1.5 text-[9px] text-slate-500">
          Computer-generated clinical record from Vlack HRMS. Electronically signed entries do not need a wet signature. Every print is audited.
        </footer>
      </article>
    </div>
  )
}

function PatientBanner({ h }: { h?: Header }) {
  if (!h) return null
  return (
    <table className="mb-3 w-full border border-slate-400 text-[11px]">
      <tbody>
        <tr>
          <td className="border border-slate-300 px-2 py-1"><b>Patient</b> {h.name}</td>
          <td className="border border-slate-300 px-2 py-1"><b>UHID</b> {h.uhid}</td>
          <td className="border border-slate-300 px-2 py-1"><b>Age / Sex</b> {h.age ?? '—'} y / {h.gender ?? '—'}</td>
          <td className="border border-slate-300 px-2 py-1"><b>Blood group</b> {h.blood_group ?? '—'}</td>
        </tr>
        {h.admission && (
          <tr>
            <td className="border border-slate-300 px-2 py-1"><b>{h.admission.type === 'IPD' ? 'IP no.' : 'Visit'}</b> {h.admission.code}</td>
            <td className="border border-slate-300 px-2 py-1"><b>Ward / bed</b> {h.admission.location ?? '—'}</td>
            <td className="border border-slate-300 px-2 py-1"><b>Consultant</b> {h.admission.doctor_name ?? '—'}</td>
            <td className="border border-slate-300 px-2 py-1"><b>Admitted</b> {dateTime(h.admission.started_at)}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

/** One entry rendered as a paper form (used for single prints and inside the booklet). */
export function EntryPaper({ def, entry }: { def: FormDef; entry: Entry }) {
  const ev = evaluate(def, entry.answers)
  const values = ev.values
  return (
    <section className="break-inside-avoid-page">
      <div className="mb-2 flex items-end justify-between border-b border-slate-400 pb-1">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide">{def.title}</h2>
          {def.group && <div className="text-[10px] text-slate-600">OT file · {def.group}</div>}
        </div>
        <div className="text-right text-[10px] text-slate-600">{entry.code} · {entry.status}<br />{dateTime(entry.noted_at)}</div>
      </div>
      {def.score && entry.score !== null && entry.score !== undefined && (
        <div className="mb-2 rounded border border-slate-500 px-2 py-1 text-[11px]">
          <b>{entry.score_label} {entry.score}{def.score.unit ? ` ${def.score.unit}` : ''}</b>{entry.risk_band ? ` — ${entry.risk_band}` : ''}
          {entry.band?.action && <div className="text-slate-700">{entry.band.action}</div>}
        </div>
      )}
      {def.sections.filter((s) => condOk(s.show_if, values)).map((s) => {
        const fields = s.fields.filter((f) => f.type !== 'info' && condOk(f.show_if, values))
        if (!fields.length) return null
        return (
          <div key={s.key} className="mb-2 break-inside-avoid">
            <div className="mb-1 bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold print:bg-slate-100">{s.title}</div>
            <div className="grid grid-cols-4 gap-x-3 gap-y-1">
              {fields.map((f) => {
                const wide = f.type === 'textarea' || f.type === 'lines' || f.type === 'multiselect' || f.type === 'choice' || f.width === 'full' || f.width === 'half'
                return (
                  <div key={f.key} className={wide ? (f.type === 'lines' || f.width === 'full' ? 'col-span-4' : 'col-span-2') : 'col-span-1'}>
                    <div className="text-[9px] uppercase tracking-wide text-slate-500">{f.label}</div>
                    <div className="min-h-4 border-b border-dotted border-slate-300">{isEmpty(values[f.key]) ? '' : <AnswerValue f={f} value={values[f.key]} refs={entry.refs} />}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <div className="mt-2 grid grid-cols-2 gap-4 text-[10px]">
        <div><b>Recorded by</b> {entry.author_name ?? '—'}</div>
        <div><b>Signed by</b> {entry.signed_by_name ? `${entry.signed_by_name} · ${dateTime(entry.signed_at)}` : 'Not signed (draft)'}</div>
      </div>
      {entry.amendments?.length > 0 && (
        <div className="mt-2 text-[10px]">
          <b>Amendments</b>
          {entry.amendments.map((a, i) => <div key={i}>{dateTime(a.at)} · {a.by_name}: {a.reason} ({a.fields.length} field{a.fields.length > 1 ? 's' : ''})</div>)}
        </div>
      )}
    </section>
  )
}

export function EntryPrint() {
  const { id = '' } = useParams()
  const entry = useQuery({ queryKey: ['forms-print-entry', id], queryFn: () => api<Entry>(`/forms/entries/${id}`) })
  const def = useQuery({ queryKey: ['forms-def', entry.data?.form_key], queryFn: () => api<FormDef>(`/forms/defs/${entry.data!.form_key}`), enabled: !!entry.data })
  const header = useHeader(entry.data?.patient_id, entry.data?.encounter_id)
  const ready = !!(entry.data && def.data && header.data)
  useEffect(() => { if (entry.data) void api(`/forms/entries/${id}/print`, { method: 'POST' }).catch(() => {}) }, [entry.data, id])
  useAutoPrint(ready)
  if (entry.error || def.error) return <div className="p-6"><ErrorBox error={entry.error ?? def.error} /></div>
  if (!ready) return <Spinner label="Preparing print…" />
  return <Paper><PatientBanner h={header.data} /><EntryPaper def={def.data!} entry={entry.data!} /></Paper>
}

export function BookletPrint() {
  const [sp] = useSearchParams()
  const patient = sp.get('patient') ?? '', encounter = sp.get('encounter') ?? undefined, booking = sp.get('booking') ?? undefined
  const book = useQuery({ queryKey: ['forms-print-booklet', patient, encounter, booking],
    queryFn: () => api<Booklet>('/forms/ot/booklet', { query: { patient_id: patient, encounter_id: encounter, booking_id: booking } }), enabled: !!patient })
  const header = useHeader(patient, encounter)
  const sheets = (book.data?.sheets ?? []).filter((s) => s.entry)
  const entries = useQueries({ queries: sheets.map((s) => ({ queryKey: ['forms-print-entry', s.entry!.id], queryFn: () => api<Entry>(`/forms/entries/${s.entry!.id}`) })) })
  const defs = useQueries({ queries: sheets.map((s) => ({ queryKey: ['forms-def', s.key], queryFn: () => api<FormDef>(`/forms/defs/${s.key}`), staleTime: 600_000 })) })
  const ready = !!book.data && !!header.data && entries.every((q) => q.data) && defs.every((q) => q.data)
  useAutoPrint(ready)
  if (book.error) return <div className="p-6"><ErrorBox error={book.error} /></div>
  if (!ready) return <Spinner label="Preparing the OT booklet…" />
  const b = book.data!
  return (
    <Paper>
      <PatientBanner h={header.data} />
      <div className="mb-3 text-[11px]">
        <b>OT booklet</b>{b.booking ? ` · ${b.booking.code} · ${b.booking.procedure} · ${dateTime(b.booking.scheduled_at)}${b.booking.theatre ? ` · ${b.booking.theatre}` : ''}` : ' · sheets saved against the admission (no OT booking)'}
        <div className="text-slate-600">{b.counts.completed} of {b.counts.total} sheets completed. Pending: {b.sheets.filter((s) => s.status === 'Pending').map((s) => s.short).join(', ') || 'none'}.</div>
      </div>
      {sheets.map((s, i) => (
        <div key={s.key} className={i ? 'mt-6 break-before-page' : ''}>
          <EntryPaper def={defs[i].data!} entry={entries[i].data!} />
        </div>
      ))}
    </Paper>
  )
}

export function IoChartPrint() {
  const [sp] = useSearchParams()
  const patient = sp.get('patient') ?? ''
  const query = { patient_id: patient, encounter_id: sp.get('encounter') ?? undefined, period: sp.get('period') === 'stay' ? 'stay' : 'custom', start: sp.get('start') ?? undefined, end: sp.get('end') ?? undefined }
  const bal = useQuery({ queryKey: ['forms-print-io', query], queryFn: () => api<Balance>('/forms/io/balance', { query }), enabled: !!patient })
  const header = useHeader(patient, query.encounter_id)
  const ready = !!bal.data && !!header.data
  useAutoPrint(ready)
  if (bal.error) return <div className="p-6"><ErrorBox error={bal.error} /></div>
  if (!ready) return <Spinner label="Preparing the fluid balance chart…" />
  return (
    <Paper>
      <PatientBanner h={header.data} />
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide">Intake / output & fluid balance</h2>
      <div className="mb-2 text-[11px] text-slate-600">{dateTime(bal.data!.window.start)} → {dateTime(bal.data!.window.end)} · clinical day runs 08:00 → 08:00</div>
      <div className="-mx-4"><BalanceView b={bal.data!} print readOnly /></div>
    </Paper>
  )
}

export default EntryPrint
