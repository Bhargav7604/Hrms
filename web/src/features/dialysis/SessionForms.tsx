import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn, FieldWrap, Input, Modal, Select, Textarea } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { date, minutes, time } from '@/lib/format'
import {
  ACCESS_TYPES, BP_RE, DK, EVENTS, fieldErrors, MACHINE_TONE, MODALITIES, numOrUndef, type ChartRow, type DeskRecord, type Machine, type Session,
} from './api'

/** The forms of one dialysis session: check-in → start (machine allocation) → intradialytic chart → check-out, and cancel. */

type Errors = Record<string, string>

export function Notice({ tone = 'gray', children }: { tone?: 'gray' | 'amber' | 'red' | 'blue'; children: ReactNode }) {
  const cls = {
    gray: 'border-line bg-surface-2 text-ink-2',
    amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
    blue: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
  }[tone]
  return <div className={cn('rounded-lg border px-3 py-2 text-sm', cls)}>{children}</div>
}

function NumField({ id, label, unit, value, onChange, error, required, help, placeholder, int }: {
  id: string; label: string; unit?: string; value: string; onChange: (v: string) => void; error?: string; required?: boolean
  help?: ReactNode; placeholder?: string; int?: boolean
}) {
  return (
    <FieldWrap htmlFor={id} required={required} error={error} help={help}
      label={<>{label}{unit && <span className="font-normal text-ink-3"> ({unit})</span>}</>}>
      <Input id={id} type="number" inputMode={int ? 'numeric' : 'decimal'} step={int ? 1 : 'any'} value={value} placeholder={placeholder}
        invalid={!!error} onChange={(e) => onChange(e.target.value)} />
    </FieldWrap>
  )
}

function BpField({ id, label, value, onChange, error, required }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; required?: boolean }) {
  return (
    <FieldWrap htmlFor={id} label={<>{label} <span className="font-normal text-ink-3">(mmHg)</span></>} error={error} required={required}>
      <Input id={id} value={value} placeholder="150/90" inputMode="numeric" invalid={!!error} onChange={(e) => onChange(e.target.value.replace(/[^\d/]/g, ''))} />
    </FieldWrap>
  )
}

/** Range / format checks; returns the errors and the parsed numbers. */
function check(spec: Record<string, { v: string; min?: number; max?: number; int?: boolean; bp?: boolean; required?: boolean }>): { errs: Errors; out: Record<string, number | string> } {
  const errs: Errors = {}
  const out: Record<string, number | string> = {}
  for (const [k, c] of Object.entries(spec)) {
    const t = c.v.trim()
    if (!t) { if (c.required) errs[k] = 'Required'; continue }
    if (c.bp) {
      if (!BP_RE.test(t)) errs[k] = 'As systolic/diastolic, e.g. 150/90'
      else if (Number(t.split('/')[1]) >= Number(t.split('/')[0])) errs[k] = 'Diastolic must be lower than systolic'
      else out[k] = t
      continue
    }
    const n = numOrUndef(t)!
    if (Number.isNaN(n)) errs[k] = 'Enter a number'
    else if (c.int && !Number.isInteger(n)) errs[k] = 'Whole number'
    else if ((c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)) errs[k] = `Between ${c.min} and ${c.max}`
    else out[k] = n
  }
  return { errs, out }
}

function weightVsDry(w: string, dry?: number | null): string | null {
  const n = numOrUndef(w)
  if (n === undefined || Number.isNaN(n) || !dry) return null
  const d = Math.round((n - dry) * 10) / 10
  return d === 0 ? 'At dry weight' : `${Math.abs(d)} kg ${d > 0 ? 'above' : 'below'} dry weight (${dry} kg)`
}

// ------------------------------------------------------------------ check-in

export function CheckInForm({ r }: { r: DeskRecord }) {
  const qc = useQueryClient()
  const plan = r.plan
  const usable = r.entitlements.filter((e) => e.available > 0)
  const exhausted = r.entitlements.filter((e) => e.available <= 0)
  const choices = [
    ...usable.map((e) => ({ key: e.charge_id, charge_id: e.charge_id as string | undefined, label: `OP bill ${e.bill}`,
      sub: `${e.service ?? 'Dialysis'} · ${e.available} of ${e.sessions} session${e.sessions === 1 ? '' : 's'} unused · billed ${date(e.billed_at)}` })),
    ...(r.ip ? [{ key: 'ip', charge_id: undefined, label: `IP ${r.ip.ip_no}`,
      sub: `${[r.ip.ward, r.ip.bed].filter(Boolean).join(' / ') || 'Admitted'} · charged per session on the IP account at check-out` }] : []),
  ]
  const [picked, setChoice] = useState('')
  // the entitlements can change underneath (a new bill, a session elsewhere): fall back to the first usable one
  const choice = choices.some((c) => c.key === picked) ? picked : choices[0]?.key ?? ''
  const [f, setF] = useState({
    modality: plan?.modality && MODALITIES.includes(plan.modality) ? plan.modality : 'HD',
    pre_weight: '', pre_bp: '', pre_pulse: '', pre_temperature: '',
    access_used: plan?.vascular_access && ACCESS_TYPES.includes(plan.vascular_access) ? plan.vascular_access : '', notes: '',
  })
  const [errors, setErrors] = useState<Errors>({})
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors(({ [k]: _drop, ...rest }) => rest) }
  const m = useMutation({
    mutationFn: (body: object) => post<Session>('/dialysis/desk/check-in', body),
    onSuccess: (s) => { toast.success(`Checked in — session ${s.code}`); qc.invalidateQueries({ queryKey: DK.all }) },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errorMessage(e)) },
  })

  if (!choices.length) {
    return (
      <Notice tone="amber">
        <b>Nothing to use for a session.</b> Bill a dialysis session at the OP counter first (or admit the patient with an active dialysis prescription).
        {exhausted.length > 0 && <span className="mt-1 block text-xs">Used: {exhausted.map((e) => `bill ${e.bill} (${e.used_by.map((u) => u.code).join(', ') || 'used'})`).join('; ')}</span>}
      </Notice>
    )
  }
  const submit = () => {
    const { errs, out } = check({
      pre_weight: { v: f.pre_weight, min: 2, max: 300 }, pre_bp: { v: f.pre_bp, bp: true }, pre_pulse: { v: f.pre_pulse, min: 20, max: 250, int: true },
      pre_temperature: { v: f.pre_temperature, min: 90, max: 110 },
    })
    setErrors(errs)
    if (Object.keys(errs).length) return
    const c = choices.find((x) => x.key === choice)
    m.mutate({ patient_id: r.patient.id, charge_id: c?.charge_id, modality: f.modality, ...out, access_used: f.access_used || undefined, notes: f.notes.trim() || undefined })
  }
  const idwg = weightVsDry(f.pre_weight, plan?.dry_weight_kg)
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-ink-2">Bill this session against</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {choices.map((c) => (
            <label key={c.key} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2',
              choice === c.key ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600/30 dark:bg-brand-500/10' : 'border-line hover:bg-surface-2')}>
              <input type="radio" name="entitlement" className="mt-1 accent-brand-700" aria-label={c.label} checked={choice === c.key} onChange={() => setChoice(c.key)} />
              <span className="min-w-0"><span className="block text-sm font-medium text-ink">{c.label}</span><span className="block text-xs text-ink-2">{c.sub}</span></span>
            </label>
          ))}
          {exhausted.map((e) => (
            <div key={e.charge_id} className="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 opacity-70" aria-disabled>
              <input type="radio" disabled className="mt-1" aria-label={`Bill ${e.bill} — no unused session`} />
              <span className="min-w-0"><span className="block text-sm text-ink-2">OP bill {e.bill}</span>
                <span className="block text-xs text-ink-3">No unused session — used by {e.used_by.map((u) => `${u.code} (${u.status})`).join(', ') || 'earlier sessions'}</span></span>
            </div>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <FieldWrap label="Modality" htmlFor="ci-mod">
          <Select id="ci-mod" value={f.modality} onChange={(e) => set('modality', e.target.value)}>{MODALITIES.map((x) => <option key={x}>{x}</option>)}</Select>
        </FieldWrap>
        <NumField id="ci-wt" label="Pre weight" unit="kg" value={f.pre_weight} onChange={(v) => set('pre_weight', v)} error={errors.pre_weight} help={idwg} />
        <BpField id="ci-bp" label="Pre BP" value={f.pre_bp} onChange={(v) => set('pre_bp', v)} error={errors.pre_bp} />
        <NumField id="ci-pulse" label="Pre pulse" unit="/min" int value={f.pre_pulse} onChange={(v) => set('pre_pulse', v)} error={errors.pre_pulse} />
        <NumField id="ci-temp" label="Pre temp" unit="°F" value={f.pre_temperature} onChange={(v) => set('pre_temperature', v)} error={errors.pre_temperature} />
        <FieldWrap label="Access" htmlFor="ci-acc" error={errors.access_used}>
          <Select id="ci-acc" value={f.access_used} onChange={(e) => set('access_used', e.target.value)}>
            <option value="">—</option>{ACCESS_TYPES.map((x) => <option key={x}>{x}</option>)}
          </Select>
        </FieldWrap>
      </div>
      <FieldWrap label="Notes" htmlFor="ci-notes">
        <Textarea id="ci-notes" rows={2} maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Pre-dialysis assessment, complaints since last session" />
      </FieldWrap>
      <div className="flex justify-end"><Button variant="primary" icon="LogIn" loading={m.isPending} onClick={submit}>Check in</Button></div>
    </div>
  )
}

// ------------------------------------------------------------------ start (machine allocation)

function machineBlock(m: Machine): string {
  if (m.status !== 'Available') return `${m.status}`
  return m.warning ?? 'Not compatible with this patient'
}

export function StartForm({ r, s }: { r: DeskRecord; s: Session }) {
  const qc = useQueryClient()
  const plan = r.plan as (DeskRecord['plan'] & { preferred_machine?: string | null }) | null
  const usable = r.machines.filter((m) => m.compatible && m.status === 'Available')
  const others = r.machines.filter((m) => !usable.includes(m) && m.status !== 'Retired')
  const preferred = usable.find((m) => m.id === plan?.preferred_machine)
  const [pickedMachine, setMachine] = useState('')
  // machines change state underneath (another session starts): never keep a machine that is no longer offered
  const machine = usable.some((m) => m.id === pickedMachine) ? pickedMachine : preferred?.id ?? (usable.length === 1 ? usable[0].id : '')
  const dry = plan?.dry_weight_kg
  const suggestUf = (w: string) => {
    const n = numOrUndef(w)
    return n !== undefined && !Number.isNaN(n) && dry ? Math.max(0, Math.round(((n - dry) * 1000) / 100) * 100) : null
  }
  const [f, setF] = useState(() => ({
    pre_weight: s.pre_weight ? String(s.pre_weight) : '', pre_bp: s.pre_bp ?? '',
    uf_goal_ml: s.uf_goal_ml ? String(s.uf_goal_ml) : String(suggestUf(s.pre_weight ? String(s.pre_weight) : '') ?? ''),
    blood_flow_rate: String(s.blood_flow_rate ?? plan?.blood_flow_rate ?? ''), heparin_units: s.heparin_units ? String(s.heparin_units) : '',
    dialyser_use_no: s.dialyser_use_no ? String(s.dialyser_use_no) : '',
  }))
  const [errors, setErrors] = useState<Errors>({})
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors(({ [k]: _drop, ...rest }) => rest) }
  const m = useMutation({
    mutationFn: (body: object) => post<Session>(`/dialysis/desk/sessions/${s.id}/start`, body),
    onSuccess: (x) => { toast.success(`Dialysis started on ${usable.find((u) => u.id === machine)?.name ?? 'the machine'}`, { description: x.machine_warning ?? undefined }); qc.invalidateQueries({ queryKey: DK.all }) },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errorMessage(e)) },
  })
  const submit = () => {
    const { errs, out } = check({
      pre_weight: { v: f.pre_weight, min: 2, max: 300, required: true }, pre_bp: { v: f.pre_bp, bp: true },
      uf_goal_ml: { v: f.uf_goal_ml, min: 0, max: 8000 }, blood_flow_rate: { v: f.blood_flow_rate, min: 50, max: 600 },
      heparin_units: { v: f.heparin_units, min: 0, max: 20000 }, dialyser_use_no: { v: f.dialyser_use_no, min: 1, max: 30, int: true },
    })
    if (!machine) errs.machine = 'Choose an available, compatible machine'
    setErrors(errs)
    if (Object.keys(errs).length) return
    m.mutate({ machine, ...out })
  }
  const sug = suggestUf(f.pre_weight)
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-ink-2">Machine <span className="text-red-600">*</span>
          <span className="ml-1 font-normal text-ink-3">— available and allowed for {plan?.viral_status ? `a ${plan.viral_status.toLowerCase()} patient` : 'a patient without a confirmed viral status'}</span>
        </legend>
        {usable.length ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Dialysis machine">
            {usable.map((mc) => (
              <label key={mc.id} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2',
                machine === mc.id ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600/30 dark:bg-brand-500/10' : 'border-line hover:bg-surface-2')}>
                <input type="radio" name="machine" className="mt-1 accent-brand-700" aria-label={`${mc.name} · ${mc.segregation ?? 'General'}`} checked={machine === mc.id} onChange={() => { setMachine(mc.id); setErrors(({ machine: _m, ...rest }) => rest) }} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">{mc.name}{mc.station && <span className="text-xs font-normal text-ink-3">{mc.station}</span>}
                    {mc.id === plan?.preferred_machine && <Badge tone="cyan">Preferred</Badge>}</span>
                  <span className="block text-xs text-ink-2">{mc.segregation ?? 'General (non-reactive)'}{mc.hdf_capable ? ' · HDF' : ''}{mc.make ? ` · ${mc.make}` : ''}</span>
                  {mc.warning && <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">⚠ {mc.warning}</span>}
                </span>
              </label>
            ))}
          </div>
        ) : <Notice tone="amber">No compatible machine is available right now. Mark a disinfected machine ready, or wait for one to free up.</Notice>}
        {errors.machine && <p className="mt-1 text-xs text-red-600">{errors.machine}</p>}
        {others.length > 0 && (
          <details className="mt-2 text-xs text-ink-2">
            <summary className="cursor-pointer select-none text-ink-3 hover:text-ink">{others.length} other machine{others.length === 1 ? '' : 's'} not offered</summary>
            <ul className="mt-1 space-y-0.5">
              {others.map((mc) => (
                <li key={mc.id} className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-ink">{mc.name}</span><Badge tone={MACHINE_TONE[mc.status] ?? 'gray'}>{mc.status}</Badge>
                  <span>{mc.segregation}</span><span className="text-ink-3">— {machineBlock(mc)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </fieldset>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <NumField id="st-wt" label="Pre weight" unit="kg" required value={f.pre_weight} onChange={(v) => set('pre_weight', v)} error={errors.pre_weight}
          help={weightVsDry(f.pre_weight, dry)} />
        <BpField id="st-bp" label="Pre BP" value={f.pre_bp} onChange={(v) => set('pre_bp', v)} error={errors.pre_bp} />
        <NumField id="st-uf" label="UF goal" unit="ml" int value={f.uf_goal_ml} onChange={(v) => set('uf_goal_ml', v)} error={errors.uf_goal_ml}
          help={sug !== null && String(sug) !== f.uf_goal_ml ? <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => set('uf_goal_ml', String(sug))}>Use {sug} ml (to dry weight)</button> : undefined} />
        <NumField id="st-qb" label="Qb" unit="ml/min" value={f.blood_flow_rate} onChange={(v) => set('blood_flow_rate', v)} error={errors.blood_flow_rate} />
        <NumField id="st-hep" label="Heparin" unit="IU" value={f.heparin_units} onChange={(v) => set('heparin_units', v)} error={errors.heparin_units}
          help={plan?.anticoagulation ?? undefined} />
        <NumField id="st-dia" label="Dialyser use #" int value={f.dialyser_use_no} onChange={(v) => set('dialyser_use_no', v)} error={errors.dialyser_use_no}
          help={plan?.dialyser ? `${plan.dialyser}` : undefined} />
      </div>
      <div className="flex justify-end"><Button variant="primary" icon="Play" loading={m.isPending} disabled={!usable.length} onClick={submit}>Start dialysis</Button></div>
    </div>
  )
}

// ------------------------------------------------------------------ intradialytic chart

const nowHHMM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const CHART_COLS: [keyof ChartRow, string][] = [['time', 'Time'], ['bp', 'BP'], ['pulse', 'Pulse'], ['qb', 'Qb'], ['venous_pressure', 'VP'],
  ['tmp', 'TMP'], ['uf_volume', 'UF so far (ml)'], ['remarks', 'Remarks']]

export function ChartPanel({ s, canOperate }: { s: Session; canOperate: boolean }) {
  const qc = useQueryClient()
  const rows = s.hourly_chart ?? []
  const lastQb = rows.length ? rows[rows.length - 1].qb : s.blood_flow_rate
  const blank = () => ({ time: nowHHMM(), bp: '', pulse: '', qb: lastQb ? String(lastQb) : '', venous_pressure: '', tmp: '', uf_volume: '', remarks: '' })
  const [f, setF] = useState(blank)
  const [errors, setErrors] = useState<Errors>({})
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors(({ [k]: _drop, ...rest }) => rest) }
  const m = useMutation({
    mutationFn: (body: object) => post<Session>(`/dialysis/desk/sessions/${s.id}/chart`, body),
    onSuccess: () => { toast.success('Observation added'); setF(blank()); qc.invalidateQueries({ queryKey: DK.all }) },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errorMessage(e)) },
  })
  const add = () => {
    const { errs, out } = check({
      bp: { v: f.bp, bp: true }, pulse: { v: f.pulse, min: 20, max: 250, int: true }, qb: { v: f.qb, min: 0, max: 600 },
      venous_pressure: { v: f.venous_pressure, min: -300, max: 500 }, tmp: { v: f.tmp, min: -200, max: 600 }, uf_volume: { v: f.uf_volume, min: 0, max: 10000 },
    })
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time)) errs.time = 'HH:MM'
    if (!Object.keys(out).length && !f.remarks.trim() && !Object.keys(errs).length) errs.bp = 'Enter at least one observation'
    setErrors(errs)
    if (Object.keys(errs).length) return
    m.mutate({ time: f.time, ...out, remarks: f.remarks.trim() || undefined })
  }
  const cell = 'h-8 w-full rounded-md border border-line-2 bg-surface px-2 text-xs text-ink focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20'
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full min-w-[46rem] text-sm">
        <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
          <tr>{CHART_COLS.map(([, h]) => <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">{h}</th>)}{canOperate && <th className="w-16" />}</tr>
        </thead>
        <tbody className="tabular">
          {rows.length === 0 && <tr><td colSpan={CHART_COLS.length + 1} className="px-2 py-3 text-center text-xs text-ink-3">No observations charted yet — chart at least hourly.</td></tr>}
          {rows.map((x, i) => (
            <tr key={i} className="border-b border-line">
              {CHART_COLS.map(([k]) => <td key={k} className="whitespace-nowrap px-2 py-1.5 text-ink">{x[k] ?? '—'}</td>)}
              {canOperate && <td />}
            </tr>
          ))}
          {canOperate && (
            <tr className="bg-surface-2/60 align-top">
              {(Object.keys(f) as (keyof typeof f)[]).map((k) => (
                <td key={k} className="px-1 py-1.5">
                  <input className={cn(cell, errors[k] && 'border-red-500')} aria-label={CHART_COLS.find(([c]) => c === k)?.[1]} value={f[k]}
                    type={k === 'time' ? 'time' : k === 'bp' || k === 'remarks' ? 'text' : 'number'} placeholder={k === 'bp' ? '140/80' : ''}
                    maxLength={k === 'remarks' ? 200 : undefined} title={errors[k]}
                    onChange={(e) => set(k, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
                  {errors[k] && <span className="mt-0.5 block text-[11px] text-red-600">{errors[k]}</span>}
                </td>
              ))}
              <td className="px-1 py-1.5"><Button size="xs" variant="primary" loading={m.isPending} onClick={add}>Add</Button></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ check-out

export function CheckOutForm({ r, s }: { r: DeskRecord; s: Session }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ post_weight: '', post_bp: '', post_pulse: '', uf_achieved_ml: '', duration_minutes: '', complications: '', drugs_given: '', ktv: '', notes: '' })
  const [ufTouched, setUfTouched] = useState(false)
  const [events, setEvents] = useState<string[]>([])
  const [errors, setErrors] = useState<Errors>({})
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors(({ [k]: _drop, ...rest }) => rest) }
  const post_w = numOrUndef(f.post_weight)
  const autoUf = s.pre_weight && post_w !== undefined && !Number.isNaN(post_w) ? Math.max(0, Math.round((s.pre_weight - post_w) * 1000)) : null
  const uf = ufTouched ? f.uf_achieved_ml : autoUf !== null ? String(autoUf) : ''
  const elapsed = s.started_at ? Math.max(0, Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000)) : null
  const needComplications = events.some((e) => e !== 'None')
  const toggle = (ev: string) => {
    setErrors(({ intradialytic_events: _e, complications: _c, ...rest }) => rest)
    setEvents((cur) => (ev === 'None' ? (cur.includes('None') ? [] : ['None'])
      : cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur.filter((x) => x !== 'None'), ev]))
  }
  const m = useMutation({
    mutationFn: (body: object) => post<Session>(`/dialysis/desk/sessions/${s.id}/check-out`, body),
    onSuccess: (x) => { toast.success(`Session ${x.code} completed${x.uf_achieved_ml !== null && x.uf_achieved_ml !== undefined ? ` · UF ${x.uf_achieved_ml} ml` : ''}`); qc.invalidateQueries({ queryKey: DK.all }) },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errorMessage(e)) },
  })
  const submit = () => {
    const { errs, out } = check({
      post_weight: { v: f.post_weight, min: 2, max: 300, required: true }, post_bp: { v: f.post_bp, bp: true },
      post_pulse: { v: f.post_pulse, min: 20, max: 250, int: true }, uf_achieved_ml: { v: uf, min: 0, max: 10000 },
      duration_minutes: { v: f.duration_minutes, min: 0, max: 900, int: true }, ktv: { v: f.ktv, min: 0, max: 4 },
    })
    if (needComplications && !f.complications.trim()) errs.complications = 'Describe the complications and how they were managed'
    setErrors(errs)
    if (Object.keys(errs).length) return
    m.mutate({
      ...out, intradialytic_events: events.length ? events : ['None'], complications: f.complications.trim() || undefined,
      drugs_given: f.drugs_given.trim() || undefined, notes: f.notes.trim() || undefined,
    })
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <NumField id="co-wt" label="Post weight" unit="kg" required value={f.post_weight} onChange={(v) => set('post_weight', v)} error={errors.post_weight}
          help={weightVsDry(f.post_weight, r.plan?.dry_weight_kg)} />
        <BpField id="co-bp" label="Post BP" value={f.post_bp} onChange={(v) => set('post_bp', v)} error={errors.post_bp} />
        <NumField id="co-pulse" label="Post pulse" unit="/min" int value={f.post_pulse} onChange={(v) => set('post_pulse', v)} error={errors.post_pulse} />
        <NumField id="co-uf" label="UF achieved" unit="ml" int value={uf} error={errors.uf_achieved_ml}
          onChange={(v) => { setUfTouched(true); set('uf_achieved_ml', v) }}
          help={!ufTouched && autoUf !== null ? `(pre ${s.pre_weight} − post) × 1000${s.uf_goal_ml ? ` · goal ${s.uf_goal_ml}` : ''}` : s.uf_goal_ml ? `Goal ${s.uf_goal_ml} ml` : undefined} />
        <NumField id="co-dur" label="Duration" unit="min" int value={f.duration_minutes} onChange={(v) => set('duration_minutes', v)} error={errors.duration_minutes}
          placeholder={elapsed !== null ? String(elapsed) : undefined} help={elapsed !== null ? `Running ${minutes(elapsed)} — blank uses the clock` : undefined} />
        <NumField id="co-ktv" label="spKt/V" value={f.ktv} onChange={(v) => set('ktv', v)} error={errors.ktv}
          help={r.plan?.target_ktv ? `Target ≥ ${r.plan.target_ktv}` : undefined} />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-ink-2">Intradialytic events</legend>
        <div className="flex flex-wrap gap-1.5">
          {EVENTS.map((ev) => {
            const on = events.includes(ev)
            return (
              <button key={ev} type="button" aria-pressed={on} onClick={() => toggle(ev)}
                className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  on ? (ev === 'None' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-amber-600 bg-amber-500 text-white') : 'border-line-2 bg-surface text-ink-2 hover:bg-surface-2')}>
                {on ? '✓ ' : ''}{ev}
              </button>
            )
          })}
        </div>
        {errors.intradialytic_events && <p className="mt-1 text-xs text-red-600">{errors.intradialytic_events}</p>}
      </fieldset>
      <div className="grid gap-3 md:grid-cols-2">
        <FieldWrap label="Complications / management" required={needComplications} error={errors.complications} htmlFor="co-comp">
          <Textarea id="co-comp" rows={2} maxLength={1000} value={f.complications} invalid={!!errors.complications} onChange={(e) => set('complications', e.target.value)}
            placeholder={needComplications ? 'What happened and how it was managed' : 'Only needed when an event is recorded'} />
        </FieldWrap>
        <FieldWrap label="Drugs given" error={errors.drugs_given} htmlFor="co-drugs">
          <Textarea id="co-drugs" rows={2} maxLength={300} value={f.drugs_given} onChange={(e) => set('drugs_given', e.target.value)} placeholder="EPO 4000 IU SC, Iron sucrose 100 mg IV" />
        </FieldWrap>
        <FieldWrap label="Notes" className="md:col-span-2" htmlFor="co-notes">
          <Textarea id="co-notes" rows={2} maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </FieldWrap>
      </div>
      <div className="flex justify-end"><Button variant="success" icon="LogOut" loading={m.isPending} onClick={submit}>Check out</Button></div>
    </div>
  )
}

// ------------------------------------------------------------------ cancel

export function CancelDialog({ s, onClose }: { s: Session; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const m = useMutation({
    mutationFn: () => post<Session>(`/dialysis/desk/sessions/${s.id}/cancel`, { reason: reason.trim() }),
    onSuccess: () => { toast.success(`Session ${s.code} cancelled`); qc.invalidateQueries({ queryKey: DK.all }); onClose() },
    onError: (e) => { setError(fieldErrors(e).reason ?? null); toast.error(errorMessage(e)) },
  })
  const submit = () => {
    if (reason.trim().length < 3) { setError('Give a reason (at least 3 characters)'); return }
    m.mutate()
  }
  return (
    <Modal open onClose={onClose} size="sm" title={`Cancel session ${s.code}`}
      footer={<><Button onClick={onClose}>Keep session</Button><Button variant="danger" loading={m.isPending} onClick={submit}>Cancel session</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-2">
          {s.status === 'In Progress'
            ? `The session is running${s.machine_name ? ` on ${s.machine_name}` : ''} since ${time(s.started_at)} — the machine goes to disinfection.`
            : 'The billed session is released and can be used again.'}
        </p>
        <FieldWrap label="Reason" required error={error ?? undefined} htmlFor="cx-reason">
          <Textarea id="cx-reason" autoFocus rows={3} maxLength={300} value={reason} invalid={!!error} onChange={(e) => { setReason(e.target.value); setError(null) }}
            placeholder="e.g. Patient unwell — referred to ER; access not usable" />
        </FieldWrap>
      </div>
    </Modal>
  )
}
