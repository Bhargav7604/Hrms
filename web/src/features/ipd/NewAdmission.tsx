import { useMutation, useQuery } from '@tanstack/react-query'
import { ScanLine, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Avatar, Badge, Button, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Select, Spinner, Switch, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import { K, optional, type PatientBrief } from './api'
import { cfgOf, Section, SearchSelect, type FieldCfg, type Opt } from './ui'

interface FormCtx {
  wards: { id: string; code: string; name: string; floor?: string | null; ward_type?: string | null; vacant: number; beds: number }[]
  departments: { id: string; name: string }[]
  doctors: { id: string; name: string; designation?: string | null; department_id?: string | null; department?: string | null }[]
  payers: { id: string; name: string; payer_type?: string | null; scheme?: string | null }[]
  packages: { id: string; name: string; price?: number | null; los_days?: number | null; room_category?: string | null }[]
  categories: { key: string; label: string }[]
  sponsor_types: Record<string, string[]>
  admission_types: string[]; admission_sources: string[]
  can_admit: boolean; can_view_money: boolean
}
interface Found extends PatientBrief { admission?: { id: string; code: string; status: string; bed?: string | null; ward?: string | null } | null }
interface ScreenCfg { fields?: Record<string, FieldCfg>; settings?: Record<string, unknown> }
interface Bed { id: string; bed_no: string; room?: string | null; category?: string | null; rate?: number | null; status: string; reserved_ref?: string | null }

const MIN = { uhid: 4, name: 3, aadhaar: 4, mobile: 5 }

export default function NewAdmission() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const ctx = useQuery({ queryKey: K.form(), queryFn: () => api<FormCtx>('/ipchart/admission-form'), staleTime: 60_000 })
  const screen = useQuery({ queryKey: ['x', 'ipd', 'screen-config'], queryFn: () => optional<ScreenCfg>('/fieldconfig/screens/ip.admission'), staleTime: 300_000 })
  const [patient, setPatient] = useState<Found | null>(null)

  if (ctx.isLoading) return <Spinner label="Loading admission form…" />
  if (ctx.error) return <ErrorBox error={ctx.error} />
  const c = ctx.data!
  if (!c.can_admit) return <Empty icon="Lock" title="Admissions are made by the front office, ward nurses and doctors">Your role can view admissions but not create them.</Empty>
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader icon="BedDouble" title="New admission" subtitle="Find the registered patient, choose the payer, consultant and a vacant bed, and admit."
        actions={<Link to="/ip/admissions" className="text-sm text-brand-700 hover:underline dark:text-brand-300">← Admissions</Link>} />
      {!patient ? <PatientLookup initial={params.get('uhid') ?? ''} onPick={setPatient} /> : (
        <AdmissionForm c={c} cfg={screen.data ?? null} patient={patient} onClear={() => setPatient(null)}
          onDone={(id) => nav(`/ip/admissions/${id}`)} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ step 1: find the patient

function PatientLookup({ initial, onPick }: { initial: string; onPick: (p: Found) => void }) {
  const [f, setF] = useState({ uhid: initial, name: '', aadhaar: '', mobile: '' })
  const [scan, setScan] = useState<string | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const d = useDebounced(f, 300)
  const q = useMemo(() => {
    const out: Record<string, string> = {}
    if (d.uhid.trim().length >= MIN.uhid) out.uhid = d.uhid.trim()
    if (d.name.replace(/[^A-Za-z]/g, '').length >= MIN.name) out.name = d.name.trim()
    if (d.aadhaar.replace(/\D/g, '').length >= MIN.aadhaar) out.aadhaar = d.aadhaar.replace(/\D/g, '').slice(-4)
    if (d.mobile.replace(/\D/g, '').length >= MIN.mobile) out.mobile = d.mobile.replace(/\D/g, '')
    if (scan) out.q = scan
    return out
  }, [d, scan])
  const ready = Object.keys(q).length > 0
  const res = useQuery({ queryKey: ['x', 'ipd', 'patient-search', q], queryFn: () => api<{ rows: Found[] }>('/ipchart/patients/search', { query: q }), enabled: ready })
  const rows = res.data?.rows ?? []
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setScan(null); setF({ ...f, [k]: e.target.value }) }
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && rows.length === 1) onPick(rows[0]) }
  const hint = (k: keyof typeof MIN, v: string) => {
    const n = k === 'name' ? v.replace(/[^A-Za-z]/g, '').length : k === 'uhid' ? v.trim().length : v.replace(/\D/g, '').length
    return v && n < MIN[k] ? `Min ${MIN[k]} ${k === 'name' ? 'letters' : k === 'aadhaar' ? 'digits (last 4)' : k === 'uhid' ? 'characters' : 'digits'}` : undefined
  }
  return (
    <Section title="Find the patient" icon="UserSearch" tone="brand" subtitle="Search starts once the minimum length is typed. Scan a UHID card or wristband with the barcode scanner.">
      <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_1fr_1fr]">
        <div className="flex items-end">
          <Button variant="secondary" onClick={() => setScanOpen(true)} title="Scan UHID / IP barcode or QR" aria-label="Scan"><ScanLine className="size-4" /> Scan</Button>
        </div>
        <FieldWrap label="UHID" help={hint('uhid', f.uhid) ?? 'Min 4 characters'}>
          <Input autoFocus value={f.uhid} onChange={set('uhid')} onKeyDown={enter} placeholder="e.g. UH00000172" />
        </FieldWrap>
        <FieldWrap label="Name" help={hint('name', f.name) ?? 'Min 3 letters'}><Input value={f.name} onChange={set('name')} onKeyDown={enter} /></FieldWrap>
        <FieldWrap label="Aadhaar (last 4)" help={hint('aadhaar', f.aadhaar) ?? 'Only the last 4 digits are stored'}>
          <Input inputMode="numeric" value={f.aadhaar} onChange={set('aadhaar')} onKeyDown={enter} maxLength={14} />
        </FieldWrap>
        <FieldWrap label="Mobile" help={hint('mobile', f.mobile) ?? 'Min 5 digits'}><Input inputMode="tel" value={f.mobile} onChange={set('mobile')} onKeyDown={enter} /></FieldWrap>
      </div>
      <div className="mt-4">
        {!ready ? <p className="text-sm text-ink-3">Type in any field — results combine all filled fields.</p>
          : res.isLoading ? <Spinner label="Searching…" />
          : res.error ? <ErrorBox error={res.error} />
          : rows.length === 0 ? <Empty icon="UserX" title="No registered patient matches">Register the patient first at the registration desk, then admit.</Empty>
          : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {rows.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => onPick(p)} className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none">
                    <Avatar name={p.name} size="sm" />
                    <span className="min-w-48 flex-1">
                      <span className="block font-medium text-ink">{p.name}</span>
                      <span className="block text-xs text-ink-3">{[p.uhid, p.age != null ? `${p.age}y` : null, p.gender, p.phone, p.aadhaar_last4 ? `Aadhaar ••••${p.aadhaar_last4}` : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    {p.admission ? <Badge tone="amber">Admitted · {p.admission.code} · {p.admission.ward} {p.admission.bed}</Badge> : <Badge tone="green">Not admitted</Badge>}
                    {p.status && p.status !== 'Active' && <Badge tone="red">{p.status}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
      <ScanDialog open={scanOpen} onClose={() => setScanOpen(false)} onScan={(v) => { setScanOpen(false); setScan(v); setF({ uhid: '', name: '', aadhaar: '', mobile: '' }) }} />
    </Section>
  )
}

interface Detector { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }
type DetectorCtor = new (o: { formats: string[] }) => Detector

/** Barcode / QR scan: keyboard-wedge scanners type into the field; supported browsers can also use the camera. */
export function ScanDialog({ open, onClose, onScan }: { open: boolean; onClose: () => void; onScan: (v: string) => void }) {
  const [v, setV] = useState('')
  const [cam, setCam] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const Ctor = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
  useEffect(() => {
    if (!open || !cam || !Ctor) return
    let stop = false
    let stream: MediaStream | null = null
    const det = new Ctor({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13'] })
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } }).then(async (s) => {
      stream = s
      if (!video.current) return
      video.current.srcObject = s
      await video.current.play()
      while (!stop) {
        try {
          const hits = await det.detect(video.current)
          if (hits[0]?.rawValue) { onScan(hits[0].rawValue.trim()); break }
        } catch { /* frame not ready */ }
        await new Promise((r) => setTimeout(r, 250))
      }
    }).catch(() => { toast.error('Camera not available'); setCam(false) })
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [open, cam, Ctor, onScan])
  return (
    <Modal open={open} onClose={() => { setCam(false); onClose() }} title="Scan UHID / IP number" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onScan(v.trim())}>Find</Button></>}>
      <FieldWrap label="Scan with the barcode scanner, or type" help="UHID card, wristband (UHID / IP number) or the patient's QR">
        <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onScan(v.trim()) }} />
      </FieldWrap>
      {Ctor && (
        <div className="mt-3">
          {cam ? <video ref={video} className="aspect-video w-full rounded-lg bg-black" muted playsInline /> : (
            <Button size="sm" icon="Camera" onClick={() => setCam(true)}>Use camera</Button>
          )}
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ step 2: admission form

interface Draft {
  payer: string; sponsor_id: string | null; authorisation_no: string; approved_amount: string
  doctor_id: string | null; second_doctor_id: string | null; department_id: string | null; ward_id: string | null; bed_id: string | null
  admission_type: string; admission_source: string; expected_los: string; reason: string; diagnosis: string
  package_admission: boolean; package_id: string | null; attendant_name: string; attendant_phone: string; mlc: boolean
}

function AdmissionForm({ c, cfg, patient, onClear, onDone }: { c: FormCtx; cfg: ScreenCfg | null; patient: Found; onClear: () => void; onDone: (id: string) => void }) {
  const fields = cfg?.fields
  const f = (k: string) => cfgOf(fields, k)
  const askSecond = cfg?.settings?.second_consultant === true
  const [showDetails, setShowDetails] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [d, setD] = useState<Draft>(() => ({
    payer: String(f('payer').def ?? (patient.payer_type && ['Cash', 'Insurance', 'Corporate', 'Government Scheme'].includes(patient.payer_type) ? patient.payer_type : 'Cash')),
    sponsor_id: null, authorisation_no: '', approved_amount: '', doctor_id: null, second_doctor_id: null, department_id: null,
    ward_id: null, bed_id: null, admission_type: String(f('admission_type').def ?? 'Elective'), admission_source: String(f('admission_source').def ?? 'OPD'),
    expected_los: '', reason: '', diagnosis: '', package_admission: false, package_id: null, attendant_name: '', attendant_phone: '', mlc: false,
  }))
  const set = <T extends keyof Draft>(k: T, v: Draft[T]) => { setD((x) => ({ ...x, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })) }
  const beds = useQuery({
    queryKey: ['x', 'ipd', 'ward-beds', d.ward_id, patient.id],
    queryFn: () => api<{ beds: Bed[] }>(`/ipchart/wards/${d.ward_id}/beds`, { query: { patient_id: patient.id } }),
    enabled: !!d.ward_id,
  })
  const sponsored = d.payer !== 'Cash'
  const types = c.sponsor_types[d.payer] ?? []
  const sponsorOpts: Opt[] = c.payers.filter((p) => !p.payer_type || types.includes(p.payer_type)).map((p) => ({ value: p.id, label: p.name, hint: [p.payer_type, p.scheme !== 'Not applicable' ? p.scheme : null].filter(Boolean).join(' · ') }))
  const doctorOpts: Opt[] = c.doctors.map((x) => ({ value: x.id, label: x.name, hint: [x.designation, x.department].filter(Boolean).join(' · ') }))
  const wardOpts: Opt[] = c.wards.map((w) => ({ value: w.id, label: w.name, hint: `${w.vacant} vacant of ${w.beds}${w.ward_type ? ` · ${w.ward_type}` : ''}`, group: w.floor ? `Floor ${w.floor}` : undefined, disabled: w.vacant === 0 }))
  const bedOpts: Opt[] = (beds.data?.beds ?? []).map((b) => ({ value: b.id, label: `Bed ${b.bed_no}`, hint: [b.category, b.room ? `Room ${b.room}` : null, c.can_view_money && b.rate ? `${money(b.rate, true)}/day` : null, b.status === 'Reserved' ? `Reserved ${b.reserved_ref ?? ''}` : null].filter(Boolean).join(' · ') }))
  const pkgOpts: Opt[] = c.packages.map((p) => ({ value: p.id, label: p.name, hint: [c.can_view_money && p.price ? money(p.price, true) : null, p.los_days ? `${p.los_days} day stay` : null, p.room_category].filter(Boolean).join(' · ') }))

  const pickDoctor = (id: string | null) => {
    const doc = c.doctors.find((x) => x.id === id)
    setD((x) => ({ ...x, doctor_id: id, department_id: x.department_id ?? doc?.department_id ?? null }))
  }
  const admit = useMutation({
    mutationFn: () => api<{ admission: { id: string; code: string } }>('/ipchart/admissions', {
      method: 'POST',
      body: {
        patient_id: patient.id, payer: d.payer, sponsor_id: sponsored ? d.sponsor_id : null,
        authorisation_no: sponsored ? d.authorisation_no || null : null, approved_amount: sponsored && d.approved_amount ? Number(d.approved_amount) : null,
        doctor_id: d.doctor_id, second_doctor_id: d.second_doctor_id, department_id: d.department_id, ward_id: d.ward_id, bed_id: d.bed_id,
        admission_type: d.admission_type, admission_source: d.admission_source, expected_los: d.expected_los ? Number(d.expected_los) : null,
        reason: d.reason || null, diagnosis: d.diagnosis, package_admission: d.package_admission, package_id: d.package_admission ? d.package_id : null,
        attendant_name: d.attendant_name || null, attendant_phone: d.attendant_phone || null, mlc: d.mlc,
      },
    }),
    onSuccess: (r) => { toast.success(`Admitted · ${r.admission.code}`); onDone(r.admission.id) },
    onError: (e) => {
      if (e instanceof ApiError) {
        const fe = e.fieldErrors
        setErrors({ ...fe, ...(fe.sponsor ? { sponsor_id: fe.sponsor } : {}), ...(fe.package ? { package_id: fe.package } : {}) })
        if (e.code === 'ALREADY_ADMITTED') { toast.error(e.message, { action: { label: 'Open chart', onClick: () => onDone(String(e.details?.admission_id)) } }); return }
      }
      toast.error(errorMessage(e))
    },
  })
  const validate = () => {
    const e: Record<string, string> = {}
    if (!d.doctor_id) e.doctor_id = 'Required'
    if (!d.ward_id) e.ward_id = 'Required'
    if (!d.bed_id) e.bed_id = 'Required'
    if (d.diagnosis.trim().length < 2) e.diagnosis = 'Required'
    if (sponsored && !d.sponsor_id) e.sponsor_id = 'Required'
    if (d.package_admission && !d.package_id) e.package_id = 'Choose the package'
    if (askSecond && !d.second_doctor_id) e.second_doctor_id = 'Required'
    for (const [k, key] of [['reason', 'reason'], ['authorisation_no', 'authorisation_no'], ['approved_amount', 'approved_amount'], ['expected_los', 'expected_los'], ['attendant_name', 'attendant_name'], ['attendant_phone', 'attendant_phone']] as const) {
      if (f(key).show && f(key).required && !String(d[k as keyof Draft] ?? '').trim() && (k !== 'authorisation_no' && k !== 'approved_amount' || sponsored)) e[k] = 'Required'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }
  const submit = () => { if (validate()) admit.mutate() }
  useShortcuts('New admission', [{ keys: 'mod+Enter', label: 'Admit patient', run: submit, allowInInput: true }])
  const blocked = !!patient.admission || (patient.status && patient.status !== 'Active')
  const L = (k: string, fallback: string) => f(k).label ?? fallback

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3">
        <Avatar name={patient.name} />
        {[['UHID', patient.uhid], ['Name', patient.name], ['Age / sex', [patient.age != null ? `${patient.age} yr` : null, patient.gender].filter(Boolean).join(' / ') || '—'],
          ['Mobile', patient.phone || '—'], ['Aadhaar', patient.aadhaar_last4 ? `•••• •••• ${patient.aadhaar_last4}` : '—']].map(([k, v]) => (
          <div key={k} className="min-w-0"><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{k}</div><div className="truncate text-sm font-medium text-ink">{v}</div></div>
        ))}
        <button type="button" onClick={onClear} className="ml-auto rounded-md p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10" aria-label="Clear patient" title="Choose another patient"><X className="size-5" /></button>
      </div>
      {patient.admission && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          Already admitted ({patient.admission.code}, {patient.admission.ward} bed {patient.admission.bed}). Use a transfer to change the bed —{' '}
          <Link className="font-medium underline" to={`/ip/admissions/${patient.admission.id}`}>open the chart</Link>.
        </div>
      )}

      <Section title="Patient details" icon="User" tone="green" actions={<button type="button" className="text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={() => setShowDetails(!showDetails)}>{showDetails ? 'Hide' : 'Show'}</button>} pad={showDetails}>
        {showDetails && (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            {[['Blood group', patient.blood_group], ['Registered payer', patient.payer_type], ['Date of birth', patient.dob], ['Record status', patient.status]].map(([k, v]) => (
              <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd className="text-ink">{v || '—'}</dd></div>
            ))}
            <div className="sm:col-span-4"><Link to={`/patients/${patient.id}`} className="text-xs text-brand-700 hover:underline dark:text-brand-300">Open patient 360° →</Link></div>
          </dl>
        )}
      </Section>

      <Section title="Payer & category" icon="Wallet" tone="indigo">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {f('payer').show && (
            <FieldWrap label={L('payer', 'Category')} required error={errors.payer}>
              <Select value={d.payer} onChange={(e) => { set('payer', e.target.value); set('sponsor_id', null) }}>
                {c.categories.map((x) => <option key={x.key} value={x.key}>{x.label}{x.key === 'Cash' ? ' (self-pay)' : ''}</option>)}
              </Select>
            </FieldWrap>
          )}
          {sponsored && f('sponsor').show && (
            <FieldWrap label={L('sponsor', 'Organisation / sponsor')} required error={errors.sponsor_id}
              help={sponsorOpts.length ? undefined : 'No active sponsor of this type — billing adds them under Insurance › Payers'}>
              <SearchSelect options={sponsorOpts} value={d.sponsor_id} onChange={(v) => set('sponsor_id', v)} invalid={!!errors.sponsor_id} placeholder="Search organisation…" />
            </FieldWrap>
          )}
          {sponsored && f('authorisation_no').show && (
            <FieldWrap label={L('authorisation_no', 'Credit / auth letter no')} required={f('authorisation_no').required} error={errors.authorisation_no}>
              <Input value={d.authorisation_no} onChange={(e) => set('authorisation_no', e.target.value)} maxLength={60} />
            </FieldWrap>
          )}
          {sponsored && f('approved_amount').show && c.can_view_money && (
            <FieldWrap label={L('approved_amount', 'Approved amount (₹)')} required={f('approved_amount').required} error={errors.approved_amount}>
              <Input type="number" min={0} step="0.01" value={d.approved_amount} onChange={(e) => set('approved_amount', e.target.value)} />
            </FieldWrap>
          )}
        </div>
      </Section>

      <Section title="Admission details" icon="Stethoscope" tone="blue">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FieldWrap label={L('doctor_id', 'Primary consultant')} required error={errors.doctor_id}>
            <SearchSelect options={doctorOpts} value={d.doctor_id} onChange={pickDoctor} invalid={!!errors.doctor_id} placeholder="Search doctor…" />
          </FieldWrap>
          {f('second_doctor').show && (
            <FieldWrap label={L('second_doctor', 'Second consultant')} required={askSecond} error={errors.second_doctor_id}>
              <SearchSelect options={doctorOpts.filter((o) => o.value !== d.doctor_id)} value={d.second_doctor_id} onChange={(v) => set('second_doctor_id', v)} placeholder="Optional" />
            </FieldWrap>
          )}
          <FieldWrap label={L('department_id', 'Department')} help="Defaults to the consultant's department">
            <SearchSelect options={c.departments.map((x) => ({ value: x.id, label: x.name }))} value={d.department_id} onChange={(v) => set('department_id', v)} />
          </FieldWrap>
          <FieldWrap label="Ward" required error={errors.ward_id}>
            <SearchSelect options={wardOpts} value={d.ward_id} onChange={(v) => { set('ward_id', v); set('bed_id', null) }} invalid={!!errors.ward_id} placeholder="Search ward…" />
          </FieldWrap>
          <FieldWrap label={L('bed_id', 'Bed')} required error={errors.bed_id}>
            {!d.ward_id ? <Input disabled placeholder="Select ward first" /> : beds.isLoading ? <Input disabled placeholder="Loading beds…" /> : (
              <SearchSelect options={bedOpts} value={d.bed_id} onChange={(v) => set('bed_id', v)} invalid={!!errors.bed_id}
                placeholder={bedOpts.length ? 'Choose a vacant bed' : 'No vacant bed in this ward'} disabled={!bedOpts.length} />
            )}
          </FieldWrap>
          {f('admission_type').show && (
            <FieldWrap label={L('admission_type', 'Admission type')}>
              <Select value={d.admission_type} onChange={(e) => set('admission_type', e.target.value)}>{c.admission_types.map((x) => <option key={x}>{x}</option>)}</Select>
            </FieldWrap>
          )}
          {f('admission_source').show && (
            <FieldWrap label={L('admission_source', 'Admitted from')}>
              <Select value={d.admission_source} onChange={(e) => set('admission_source', e.target.value)}>{c.admission_sources.map((x) => <option key={x}>{x}</option>)}</Select>
            </FieldWrap>
          )}
          {f('expected_los').show && (
            <FieldWrap label={L('expected_los', 'Expected stay (days)')} required={f('expected_los').required} error={errors.expected_los}>
              <Input type="number" min={0} max={365} value={d.expected_los} onChange={(e) => set('expected_los', e.target.value)} />
            </FieldWrap>
          )}
          {f('attendant_name').show && (
            <FieldWrap label={L('attendant_name', 'Attendant name')} required={f('attendant_name').required} error={errors.attendant_name}>
              <Input value={d.attendant_name} onChange={(e) => set('attendant_name', e.target.value)} />
            </FieldWrap>
          )}
          {f('attendant_phone').show && (
            <FieldWrap label={L('attendant_phone', 'Attendant mobile')} required={f('attendant_phone').required} error={errors.attendant_phone}>
              <Input inputMode="tel" value={d.attendant_phone} onChange={(e) => set('attendant_phone', e.target.value)} />
            </FieldWrap>
          )}
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {f('reason').show && (
            <FieldWrap label={L('reason', 'Reason for admission')} required={f('reason').required} error={errors.reason}>
              <Textarea rows={3} value={d.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Presenting complaints and why admission is needed" />
            </FieldWrap>
          )}
          <FieldWrap label={L('diagnosis', 'Provisional diagnosis')} required error={errors.diagnosis}>
            <Textarea rows={3} value={d.diagnosis} onChange={(e) => set('diagnosis', e.target.value)} invalid={!!errors.diagnosis} />
          </FieldWrap>
        </div>
        {f('mlc').show && (
          <label className="mt-3 inline-flex items-center gap-2 text-sm text-ink">
            <Switch checked={d.mlc} onChange={(v) => set('mlc', v)} label="Medico-legal case" /> Medico-legal case (MLC)
          </label>
        )}
      </Section>

      {f('package_admission').show && (
        <Section title="Package" icon="Package" tone="orange">
          <div className="flex flex-wrap items-end gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-ink">
              <Switch checked={d.package_admission} onChange={(v) => { set('package_admission', v); if (!v) set('package_id', null) }} label="Package admission" />
              Package admission · <span className="font-medium">{d.package_admission ? 'Yes' : 'No'}</span>
            </label>
            {d.package_admission && (
              <FieldWrap label={L('package', 'Package')} required error={errors.package_id} className="min-w-72 flex-1">
                <SearchSelect options={pkgOpts} value={d.package_id} onChange={(v) => set('package_id', v)} invalid={!!errors.package_id} placeholder="Search package…" />
              </FieldWrap>
            )}
          </div>
        </Section>
      )}

      {cfg?.settings?.deposit_mandatory === true && (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
          This hospital requires an admission deposit — collect it at the billing counter after admitting.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3 pb-4">
        <span className="text-xs text-ink-3">Ctrl/⌘ + Enter to admit</span>
        <Button variant="ghost" onClick={onClear}>Cancel</Button>
        <Button variant="primary" icon="BedDouble" loading={admit.isPending} disabled={!!blocked} onClick={submit}>Admit patient</Button>
      </div>
    </div>
  )
}

