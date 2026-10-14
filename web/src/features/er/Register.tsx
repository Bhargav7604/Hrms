import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, PageHeader, Segmented, Select, Spinner, Switch, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { age, nowLocal } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import type { Rec } from '@/lib/types'
import { chartLink, erKey, useErRefresh, useErSettings, type RolePerms } from './api'
import { targetText, TRIAGE_DOT } from './ui'

type Mode = 'existing' | 'new' | 'unidentified'
type Dup = { id: string; code: string; title: string; phone?: string; dob?: string; gender?: string; reasons: string[]; score: number }
interface Doctor { id: string; name: string; department?: string | null; active: number; on_duty: boolean | null; primary: boolean }
interface BoardLite { wards: { id: string; name: string }[]; ward_id: string | null; beds: { id: string; bed_no: string; status: string }[]; permissions: RolePerms }

const ARRIVAL = ['Walk-in', 'Ambulance (108)', 'Private Ambulance', 'Police', 'Referred']
const BROUGHT_BY = ['Self', 'Relatives', 'Police', '108 ambulance', 'Private ambulance', 'Good Samaritan', 'Referred from hospital', 'Other']
const PAYERS = ['Self-pay', 'Insurance', 'Corporate', 'Government scheme']
const GENDERS = ['Male', 'Female', 'Transgender', 'Other']
const MLC_TYPES = ['Road traffic accident', 'Assault', 'Burns', 'Poisoning', 'Snake bite', 'Dog bite', 'Fall from height',
  'Hanging / attempted suicide', 'Sexual assault', 'Industrial accident', 'Brought dead', 'Unknown cause', 'Other']

export default function Register({ embedded = false }: { embedded?: boolean }) {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const refresh = useErRefresh()
  const settings = useErSettings()
  const [mode, setMode] = useState<Mode>('existing')
  const [patient, setPatient] = useState<Rec | null>(null)
  const [np, setNp] = useState({ first_name: '', last_name: '', gender: '', age_years: '', dob: '', phone: '', city: '', address: '' })
  const [unk, setUnk] = useState({ gender: 'Male', approx_age: '', identification_marks: '', found_at: '' })
  const [v, setV] = useState({
    arrival_mode: 'Walk-in', arrived_at: nowLocal(), chief_complaint: '', brought_by_type: '', brought_by: '', attendant_phone: '',
    police_station: '', police_officer: '', payer: 'Self-pay', triage_level: '', mlc: false, mlc_no: '', mlc_case_type: '',
  })
  const [ward, setWard] = useState('')
  const [bed, setBed] = useState(params.get('bed') ?? '')
  const [autoAssign, setAutoAssign] = useState(true)
  const [doctor, setDoctor] = useState('')
  const [dups, setDups] = useState<Dup[] | null>(null)
  const [conflict, setConflict] = useState<{ id: string; code: string; message: string } | null>(null)

  useEffect(() => {
    const r = settings.data?.registration
    if (r) setV((x) => ({ ...x, arrival_mode: r.default_arrival_mode || x.arrival_mode, payer: r.default_payer || x.payer }))
  }, [settings.data])
  useEffect(() => {
    // Police arrivals (configurable) are medico-legal by default.
    if (settings.data?.registration.mlc_arrival_modes.includes(v.arrival_mode)) setV((x) => ({ ...x, mlc: true, brought_by_type: x.brought_by_type || 'Police' }))
  }, [v.arrival_mode, settings.data])

  const board = useQuery({ queryKey: erKey('board', ward || 'default'), queryFn: () => api<BoardLite>('/er/board', { query: { ward: ward || undefined } }) })
  const doctors = useQuery({ queryKey: erKey('doctors'), queryFn: () => api<{ doctors: Doctor[]; suggested?: string; roster_based: boolean }>('/er/doctors') })
  const vacant = (board.data?.beds ?? []).filter((b) => b.status === 'Vacant')
  const suggested = doctors.data?.doctors.find((d) => d.id === doctors.data?.suggested)
  const levels = (settings.data?.triage.levels ?? []).filter((l) => l.enabled !== false)

  const submit = useMutation({
    mutationFn: (force: boolean) => {
      const body: Record<string, unknown> = {
        mode, arrival_mode: v.arrival_mode, arrived_at: v.arrived_at ? new Date(v.arrived_at).toISOString() : null,
        chief_complaint: v.chief_complaint.trim(), payer: v.payer, triage_level: v.triage_level || null,
        brought_by_type: v.brought_by_type || null, brought_by: v.brought_by || null, attendant_phone: v.attendant_phone || null,
        police_station: v.police_station || null, police_officer: v.police_officer || null,
        mlc: v.mlc, mlc_no: v.mlc_no || null, mlc_case_type: v.mlc_case_type || null,
        bed_id: bed || null, auto_assign: autoAssign && !doctor, doctor_id: autoAssign ? null : doctor || null,
      }
      if (mode === 'existing') body.patient_id = patient?.id
      if (mode === 'new') body.patient = { ...np, age_years: np.age_years ? Number(np.age_years) : null, dob: np.dob || null, force }
      if (mode === 'unidentified') body.unknown = { ...unk, approx_age: unk.approx_age ? Number(unk.approx_age) : null }
      return api<{ visit: { id: string; code: string }; patient: Rec }>('/er/register', { method: 'POST', body })
    },
    onSuccess: (r) => {
      toast.success(`${r.visit.code} registered — ${r.patient.title}`)
      refresh()
      nav(chartLink(r.visit.id))
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE') { setDups((e.details?.duplicates as Dup[]) ?? []); return }
      if (e instanceof ApiError && e.code === 'ER_ACTIVE_VISIT') {
        setConflict({ id: String(e.details?.visit_id), code: String(e.details?.code), message: e.message }); return
      }
      toast.error(errorMessage(e))
    },
  })
  const ready = v.chief_complaint.trim().length >= 2 && (
    mode === 'existing' ? !!patient : mode === 'new' ? !!(np.first_name && np.gender && np.phone.length >= 10) : !!unk.gender)
  useShortcuts('ER registration', [
    { keys: 'mod+enter', label: 'Register', allowInInput: true, run: () => ready && submit.mutate(false) },
  ])

  if (board.data && !board.data.permissions.register) {
    return <Empty icon="Lock" title="ER registration is not available to your role" />
  }
  const police = v.arrival_mode === 'Police' || v.brought_by_type === 'Police' || v.mlc

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit.mutate(false) }}>
      {!embedded && (
        <PageHeader icon="UserPlus" title="ER registration" subtitle="Enrol a patient in the emergency department — known, new or unidentified — and place them on an ER bed."
          actions={<Link to="/er/board"><Button size="sm" icon="Siren">Ward board</Button></Link>} />
      )}

      <Card title="Patient" icon="User" actions={
        <Segmented value={mode} onChange={(m) => { setMode(m); setDups(null); setConflict(null) }}
          options={[{ key: 'existing', label: 'Registered patient' }, { key: 'new', label: 'New patient' }, { key: 'unidentified', label: 'Unidentified' }]} />
      }>
        {mode === 'existing' && (
          <div className="grid gap-3 md:grid-cols-[minmax(0,420px)_1fr]">
            <FieldWrap label="Search by UHID, mobile or name" required>
              <RefPicker refName="registration.patients" kind="patient" value={patient?.id ?? null} autoFocus
                onChange={(_, r) => { setPatient(r ?? null); setConflict(null) }} placeholder="UHID / mobile / name…" />
            </FieldWrap>
            {patient && (
              <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm ring-1 ring-line">
                <Icon name="UserRound" className="size-8 text-ink-3" />
                <div>
                  <div className="font-medium text-ink">{patient.title}</div>
                  <div className="text-xs text-ink-3">{patient.code} · {[age(patient.dob), patient.gender].filter(Boolean).join(' ')} · {patient.phone ?? 'no mobile'}</div>
                </div>
                {patient.status !== 'Active' && <Badge tone="red">{patient.status}</Badge>}
              </div>
            )}
          </div>
        )}
        {mode === 'new' && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FieldWrap label="First name" required><Input value={np.first_name} onChange={(e) => setNp({ ...np, first_name: e.target.value })} autoFocus /></FieldWrap>
            <FieldWrap label="Last name"><Input value={np.last_name} onChange={(e) => setNp({ ...np, last_name: e.target.value })} /></FieldWrap>
            <FieldWrap label="Gender" required>
              <Select value={np.gender} onChange={(e) => setNp({ ...np, gender: e.target.value })}>
                <option value="">Select…</option>{GENDERS.map((g) => <option key={g}>{g}</option>)}
              </Select>
            </FieldWrap>
            <FieldWrap label="Mobile" required><Input inputMode="tel" value={np.phone} onChange={(e) => setNp({ ...np, phone: e.target.value.replace(/[^\d+]/g, '') })} placeholder="10-digit mobile" /></FieldWrap>
            <FieldWrap label="Age (years)" help="Or the date of birth"><Input type="number" min={0} max={120} value={np.age_years} onChange={(e) => setNp({ ...np, age_years: e.target.value })} /></FieldWrap>
            <FieldWrap label="Date of birth"><Input type="date" value={np.dob} onChange={(e) => setNp({ ...np, dob: e.target.value })} /></FieldWrap>
            <FieldWrap label="City"><Input value={np.city} onChange={(e) => setNp({ ...np, city: e.target.value })} /></FieldWrap>
            <FieldWrap label="Address"><Input value={np.address} onChange={(e) => setNp({ ...np, address: e.target.value })} /></FieldWrap>
          </div>
        )}
        {mode === 'unidentified' && (
          <>
            <p className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              <Icon name="TriangleAlert" className="mt-0.5 size-4 shrink-0" />
              A temporary record ("UHID not mapped") is created, e.g. <b>Unknown male ~30y</b>. Add the details or link the registered UHID from the chart once the patient is identified.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FieldWrap label="Apparent gender" required>
                <Select value={unk.gender} onChange={(e) => setUnk({ ...unk, gender: e.target.value })}>{GENDERS.map((g) => <option key={g}>{g}</option>)}</Select>
              </FieldWrap>
              <FieldWrap label="Apparent age (years)"><Input type="number" min={0} max={120} value={unk.approx_age} onChange={(e) => setUnk({ ...unk, approx_age: e.target.value })} /></FieldWrap>
              <FieldWrap label="Found at / brought from" className="lg:col-span-2"><Input value={unk.found_at} onChange={(e) => setUnk({ ...unk, found_at: e.target.value })} placeholder="e.g. NH-16 near the toll plaza" /></FieldWrap>
              <FieldWrap label="Identification marks" className="sm:col-span-2 lg:col-span-4" help="Two marks for MLC records (mole, scar, tattoo…)">
                <Textarea rows={2} value={unk.identification_marks} onChange={(e) => setUnk({ ...unk, identification_marks: e.target.value })} />
              </FieldWrap>
            </div>
          </>
        )}
        {dups && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
            <p className="font-medium text-amber-900 dark:text-amber-200">Possible duplicate — this person may already be registered</p>
            <ul className="mt-2 space-y-1.5">
              {dups.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-2 py-1.5 ring-1 ring-line">
                  <span><b className="text-ink">{d.title}</b> <span className="text-ink-3">{d.code} · {d.phone} · {d.reasons.join(', ')}</span></span>
                  <Button size="xs" variant="primary" type="button" onClick={() => { setMode('existing'); setPatient({ id: d.id, title: d.title, code: d.code, phone: d.phone, dob: d.dob, gender: d.gender, status: 'Active' }); setDups(null) }}>Use this UHID</Button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="warning" type="button" className="mt-2" loading={submit.isPending} onClick={() => submit.mutate(true)}>Not the same person — register new</Button>
          </div>
        )}
        {conflict && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            {conflict.message}
            <Link to={chartLink(conflict.id)}><Button size="xs" type="button">Open {conflict.code}</Button></Link>
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Arrival" icon="Ambulance">
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldWrap label="Arrival mode">
              <Select value={v.arrival_mode} onChange={(e) => setV({ ...v, arrival_mode: e.target.value })}>{ARRIVAL.map((a) => <option key={a}>{a}</option>)}</Select>
            </FieldWrap>
            <FieldWrap label="Arrived at"><Input type="datetime-local" value={v.arrived_at} max={nowLocal()} onChange={(e) => setV({ ...v, arrived_at: e.target.value })} /></FieldWrap>
            <FieldWrap label="Brought by">
              <Select value={v.brought_by_type} onChange={(e) => setV({ ...v, brought_by_type: e.target.value })}>
                <option value="">Select…</option>{BROUGHT_BY.map((b) => <option key={b}>{b}</option>)}
              </Select>
            </FieldWrap>
            <FieldWrap label="Name / relation"><Input value={v.brought_by} onChange={(e) => setV({ ...v, brought_by: e.target.value })} placeholder="e.g. Ravi (son)" /></FieldWrap>
            <FieldWrap label="Attendant mobile"><Input inputMode="tel" value={v.attendant_phone} onChange={(e) => setV({ ...v, attendant_phone: e.target.value })} /></FieldWrap>
            <FieldWrap label="Payer">
              <Select value={v.payer} onChange={(e) => setV({ ...v, payer: e.target.value })}>{PAYERS.map((p) => <option key={p}>{p}</option>)}</Select>
            </FieldWrap>
            {police && <FieldWrap label="Police station"><Input value={v.police_station} onChange={(e) => setV({ ...v, police_station: e.target.value })} /></FieldWrap>}
            {police && <FieldWrap label="Officer / buckle no."><Input value={v.police_officer} onChange={(e) => setV({ ...v, police_officer: e.target.value })} /></FieldWrap>}
          </div>
          <div className="mt-4 rounded-lg bg-surface-2 p-3 ring-1 ring-line">
            <label className="flex items-center justify-between gap-3 text-sm font-medium text-ink">
              <span className="flex items-center gap-2"><Icon name="ShieldAlert" className="size-4 text-violet-600" /> Medico-legal case (MLC)</span>
              <Switch checked={v.mlc} onChange={(c) => setV({ ...v, mlc: c })} label="Medico-legal case" />
            </label>
            {v.mlc && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <FieldWrap label="MLC number (if issued)"><Input value={v.mlc_no} onChange={(e) => setV({ ...v, mlc_no: e.target.value })} /></FieldWrap>
                <FieldWrap label="Case type">
                  <Select value={v.mlc_case_type} onChange={(e) => setV({ ...v, mlc_case_type: e.target.value })}>
                    <option value="">Unknown cause</option>{MLC_TYPES.map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </FieldWrap>
              </div>
            )}
          </div>
        </Card>

        <Card title="Presenting complaint & triage" icon="Siren">
          <FieldWrap label="Presenting complaint" required>
            <Textarea rows={2} value={v.chief_complaint} onChange={(e) => setV({ ...v, chief_complaint: e.target.value })} placeholder="e.g. Road traffic accident — head injury, unconscious" />
          </FieldWrap>
          <p className="mb-1.5 mt-3 text-xs font-medium text-ink-2">Triage level <span className="font-normal text-ink-3">(or triage after registration)</span></p>
          <div className="grid gap-2 sm:grid-cols-2">
            {levels.map((l) => {
              const on = v.triage_level === l.key
              return (
                <button key={l.key} type="button" aria-pressed={on} onClick={() => setV({ ...v, triage_level: on ? '' : l.key })}
                  className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm', on ? 'border-brand-700 bg-brand-50 ring-2 ring-brand-700/20 dark:bg-brand-500/15' : 'border-line-2 hover:bg-surface-2')}>
                  <span className={cn('size-3 shrink-0 rounded-full', TRIAGE_DOT[l.color ?? l.key])} />
                  <span className="flex-1">
                    <span className="block font-medium text-ink">{l.label}{l.priority && ` (${l.priority})`}</span>
                    <span className="text-xs text-ink-3">Doctor within: {targetText(l.target_minutes)}</span>
                  </span>
                  {on && <Icon name="Check" className="size-4 text-brand-700" />}
                </button>
              )
            })}
          </div>
        </Card>
      </div>

      <Card title="Placement" icon="BedDouble">
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-ink-2">ER bed</span>
              {(board.data?.wards.length ?? 0) > 1 && (
                <Select className="h-8 w-56" value={ward || board.data?.ward_id || ''} onChange={(e) => { setWard(e.target.value); setBed('') }}>
                  {board.data?.wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              )}
              <span className="text-xs text-ink-3">{vacant.length} vacant · leave empty to place the patient in the triage area</span>
            </div>
            {board.isLoading ? <Spinner /> : board.error ? <ErrorBox error={board.error} /> : vacant.length === 0 ? (
              <p className="rounded-lg bg-surface-2 px-3 py-4 text-sm text-ink-2">No vacant ER bed — the patient waits in the triage area and gets a bed from the ward board.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 lg:grid-cols-10">
                {vacant.map((b) => (
                  <button key={b.id} type="button" aria-pressed={bed === b.id} onClick={() => setBed(bed === b.id ? '' : b.id)}
                    className={cn('rounded-lg border px-1 py-2 text-xs font-semibold', bed === b.id ? 'border-brand-700 bg-brand-700 text-white' : 'border-emerald-300 bg-emerald-50/60 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200')}>
                    {b.bed_no}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-2 flex items-center justify-between text-sm font-medium text-ink">
              Auto-assign the least-loaded ER doctor
              <Switch checked={autoAssign} onChange={setAutoAssign} label="Auto-assign doctor" />
            </label>
            {autoAssign ? (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2 ring-1 ring-line">
                {suggested ? <>Will assign <b className="text-ink">{suggested.name}</b> · {suggested.active} active</> : 'No ER doctor available — assign from the chart.'}
              </p>
            ) : (
              <Select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
                <option value="">Assign later</option>
                {doctors.data?.doctors.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.department ?? '—'} · {d.active} active{d.on_duty ? ' · on duty' : ''}</option>)}
              </Select>
            )}
          </div>
        </div>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-plane/95 px-1 py-3 backdrop-blur">
        <span className="mr-auto text-xs text-ink-3">⌘/Ctrl + Enter to register</span>
        <Button type="button" variant="ghost" onClick={() => nav(-1)}>Cancel</Button>
        <Button type="submit" variant="primary" icon="UserPlus" disabled={!ready} loading={submit.isPending}>Register & open chart</Button>
      </div>
    </form>
  )
}
