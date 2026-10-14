import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ClipboardList, Loader2, MapPin, ShieldCheck, User, UserCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker, useDebounced } from '@/components/fields'
import {
  Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Popover, Select, Spinner, Textarea,
} from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useAuth, useRegistry } from '@/lib/auth'
import { date as fmtDate, money } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import type { FieldDef, Rec } from '@/lib/types'
import { AadhaarScanModal } from './AadhaarScan'
import {
  aadhaarValid, ageFromDob, digits, dobFromAge, fullName, groupAadhaar, groupAbha, MOBILE_RE, PAN_RE, PASSPORT_RE, useRegConfig,
  useScreenConfig, VOTER_RE, type AadhaarData, type ConsultingDoctor, type Dup, type FieldRule, type PincodeInfo, type RegisterResult, type Ymd,
} from './api'
import { DraftsModal, RegisteredModal } from './Lists'
import { PhotoButton } from './PhotoCapture'

type Vals = Record<string, unknown>

// Field Configuration › Patient Registration sections, grouped into the three bands of the desk.
const FALLBACK_SECTIONS: { key: string; fields: string[] }[] = [
  { key: 'category', fields: ['category', 'payer_type', 'sponsor', 'tags'] },
  { key: 'identity', fields: ['salutation', 'first_name', 'middle_name', 'last_name', 'gender', 'dob', 'age', 'blood_group', 'marital_status',
    'occupation', 'religion', 'guardian_relation', 'guardian_name'] },
  { key: 'contact', fields: ['phone', 'alternate_phone', 'email', 'attender_name', 'attender_phone', 'emergency_contact_phone'] },
  { key: 'address', fields: ['pincode', 'country', 'state', 'district', 'city', 'area', 'address'] },
  { key: 'documents', fields: ['id_number', 'pan', 'passport_no', 'driving_licence', 'abha_id', 'abha_address'] },
  { key: 'visit', fields: ['visit_type', 'consulting_doctor', 'chief_complaint'] },
  { key: 'referral', fields: ['referral_category', 'referral_name', 'referral_remarks'] },
]
const BANDS = [
  { key: 'patient', label: 'Patient details', icon: User, sections: ['category', 'identity', 'contact', 'organisation', 'financial', 'family', 'history', 'consent'] },
  { key: 'address', label: 'Address & identity', icon: MapPin, sections: ['address', 'documents'] },
  { key: 'visit', label: 'Visit & referral', icon: ClipboardList, sections: ['visit', 'referral'] },
] as const
const SPONSORED_SECTIONS = new Set(['organisation', 'financial'])
const VISIT_KEYS = new Set(['visit_type', 'visit_department', 'consulting_doctor', 'chief_complaint', 'visit_priority'])
const SKIP_KEYS = new Set(['id_type', 'photo', 'edit_document', 'edit_reason', 'family_link'])
const WIDE = new Set(['address', 'chief_complaint', 'referral_remarks', 'current_medications', 'past_history', 'tags'])
const PHONE_KEYS = ['phone', 'alternate_phone', 'attender_phone', 'emergency_contact_phone', 'next_of_kin_phone']
const UPPER_KEYS = new Set(['pan', 'passport_no', 'driving_licence', 'voter_id'])
const ERROR_ALIASES: Record<string, string> = { aadhaar: 'id_number', 'visit.consulting_doctor': 'consulting_doctor', 'visit.doctor_id': 'consulting_doctor',
  'visit.visit_type': 'visit_type', 'visit.chief_complaint': 'chief_complaint' }

interface FormState {
  v: Vals
  age: Ymd
  aadhaar: string
  qrLast4: string | null
  photo: string | null
  family: { related_patient: string | null; relationship: string }
}

function blank(defaults: Vals): FormState {
  return { v: { ...defaults }, age: {}, aadhaar: '', qrLast4: null, photo: null, family: { related_patient: null, relationship: 'Spouse' } }
}

export default function RegisterPatient({ embedded = false }: { embedded?: boolean }) {
  const reg = useRegistry()
  const { user } = useAuth()
  const nav = useNavigate()
  const ent = reg.entity('registration.patients')
  const canWrite = reg.canEntity('registration.patients', 'write')
  const canBill = reg.canPage('appointments', 'op-billing', 'edit') && ['billing', 'front_office', 'admin'].includes(user?.role ?? '')
  const cfg = useRegConfig()
  const screen = useScreenConfig('registration')
  const settings = cfg.data?.settings
  const fmap = useMemo(() => new Map((ent?.fields ?? []).map((f) => [f.key, f])), [ent])
  const rules: Record<string, FieldRule> = useMemo(() => screen.data?.fields ?? {}, [screen.data])

  const defaults = useMemo<Vals>(() => {
    const out: Vals = {}
    for (const f of ent?.fields ?? []) if (f.default !== undefined && f.default !== null && !f.hidden) out[f.key] = f.default
    for (const [k, r] of Object.entries(rules)) if (r.default !== undefined && r.default !== null && r.default !== '') out[k] = r.default
    out.category = out.category ?? settings?.default_category ?? 'General'
    out.country = out.country ?? settings?.default_country ?? 'India'
    out.state = out.state ?? settings?.default_state
    out.salutation = out.salutation ?? 'Mr.'
    out.gender = out.gender ?? 'Male'
    out.visit_type = out.visit_type ?? 'New'
    return out
  }, [ent, rules, settings])

  const [form, setForm] = useState<FormState>(() => blank({}))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [draftId, setDraftId] = useState<string | null>(null)
  const [preId, setPreId] = useState<string | null>(null)
  const [scan, setScan] = useState(false)
  const [drafts, setDrafts] = useState(false)
  const [registered, setRegistered] = useState(false)
  const [blocking, setBlocking] = useState<Dup[] | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [result, setResult] = useState<RegisterResult | null>(null)
  const [fee, setFee] = useState<{ mode: string; reference: string }>({ mode: 'CASH', reference: '' })
  const ready = !!ent && !!cfg.data && !screen.isLoading
  const initialised = useRef(false)
  const [params, setParams] = useSearchParams()

  useEffect(() => {
    if (ready && !initialised.current) {
      initialised.current = true
      setForm(blank(defaults))
    }
  }, [ready, defaults])

  // autofocus the configured field once the form is on screen
  useEffect(() => {
    if (!ready || result) return
    const key = settings?.autofocus_field || 'first_name'
    const t = window.setTimeout(() => (document.getElementById(`reg-${key}`) as HTMLElement | null)?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [ready, result, settings?.autofocus_field])

  const v = form.v
  const set = useCallback((k: string, val: unknown) => {
    setForm((s) => ({ ...s, v: { ...s.v, [k]: val } }))
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e))
  }, [])
  const setMany = useCallback((patch: Vals) => setForm((s) => ({ ...s, v: { ...s.v, ...patch } })), [])

  const sponsored = ['Corporate', 'Insurance'].includes(String(v.category ?? '')) || (!!v.payer_type && v.payer_type !== 'Cash')
  const isVisible = useCallback((key: string) => {
    if (SKIP_KEYS.has(key)) return false
    const r = rules[key]
    if (r && (r.hidden || r.visible === false)) return false
    if (key === 'sponsor' || key === 'employee_ref') return sponsored
    return true
  }, [rules, sponsored])
  const isRequired = (key: string) => !!rules[key]?.required || ['first_name', 'gender', 'phone', 'category'].includes(key)
  const label = (key: string) => rules[key]?.label || fmap.get(key)?.label || key

  // ------------------------------------------------------------------ derived data

  const doctors = useQuery({
    queryKey: ['x', 'appointments', 'doctors-today', v.visit_department ?? ''],
    queryFn: () => api<ConsultingDoctor[]>('/appointments/doctors', { query: { department_id: (v.visit_department as string) || undefined } }),
    enabled: ready && reg.canEntity('appointments.appointments', 'read') && isVisible('consulting_doctor'),
    staleTime: 60_000,
  })
  const doctor = doctors.data?.find((d) => d.id === v.consulting_doctor)

  const pin = digits(v.pincode)
  const pincode = useQuery({
    queryKey: ['x', 'registration', 'pincode', pin],
    queryFn: () => api<PincodeInfo>(`/registration/pincode/${pin}`),
    enabled: pin.length === 6, staleTime: Infinity, retry: false,
  })
  useEffect(() => {
    const p = pincode.data
    if (!p) return
    setForm((s) => ({
      ...s,
      v: { ...s.v, state: p.state ?? s.v.state, district: p.district ?? s.v.district, city: p.city ?? s.v.city,
        area: s.v.area || (p.areas.length === 1 ? p.areas[0] : s.v.area), country: p.country ?? s.v.country },
    }))
  }, [pincode.data])

  const aadhaarDigits = digits(form.aadhaar)
  const aadhaarOk = aadhaarDigits.length === 12 && aadhaarValid(aadhaarDigits)
  const dupKey = useDebounced({ phone: digits(v.phone), first_name: v.first_name, last_name: v.last_name, dob: v.dob,
    abha_id: digits(v.abha_id), abha_address: v.abha_address, pan: v.pan, passport_no: v.passport_no, aadhaar: aadhaarOk ? aadhaarDigits : '' }, 500)
  const dups = useQuery({
    queryKey: ['x', 'registration', 'dups', dupKey],
    queryFn: () => {
      const { aadhaar, ...patient } = dupKey
      return api<{ duplicates: Dup[]; keys: string[] }>('/registration/check-duplicates', { method: 'POST', body: { patient, aadhaar: aadhaar || undefined } })
    },
    enabled: ready && !result && (MOBILE_RE.test(dupKey.phone) || !!dupKey.aadhaar || dupKey.abha_id.length === 14),
  })

  // DOB ↔ age (either derives the other)
  const onDob = (d: string) => {
    const a = d ? ageFromDob(d) : null
    setForm((s) => ({ ...s, v: { ...s.v, dob: d || null }, age: a ?? {} }))
    setErrors((e) => ({ ...e, dob: '', age: '' }))
  }
  const onAge = (part: keyof Ymd, raw: string) => {
    const n = raw === '' ? '' : Math.max(0, Math.min(part === 'years' ? 130 : part === 'months' ? 11 : 30, Number(raw.replace(/\D/g, '')) || 0))
    setForm((s) => {
      const age = { ...s.age, [part]: n }
      return { ...s, age, v: { ...s.v, dob: dobFromAge(age) } }
    })
    setErrors((e) => ({ ...e, dob: '', age: '' }))
  }

  // ------------------------------------------------------------------ Aadhaar QR

  const onScanned = (d: AadhaarData) => {
    setScan(false)
    const patch: Vals = {}
    for (const k of ['first_name', 'middle_name', 'last_name', 'gender', 'guardian_relation', 'guardian_name', 'address', 'area', 'city',
      'district', 'state', 'pincode'] as const) {
      const val = d[k]
      if (val) patch[k] = val
    }
    if (d.gender === 'Female' && (v.salutation === 'Mr.' || !v.salutation)) patch.salutation = 'Ms.'
    if (d.gender === 'Male' && !v.salutation) patch.salutation = 'Mr.'
    setForm((s) => {
      const next: FormState = { ...s, v: { ...s.v, ...patch } }
      if (d.dob) { next.v.dob = d.dob; next.age = ageFromDob(d.dob) ?? {} } else if (d.age) { next.age = { years: d.age.years }; next.v.dob = dobFromAge(next.age) }
      if (d.aadhaar) { next.aadhaar = groupAadhaar(d.aadhaar); next.qrLast4 = null } else if (d.aadhaar_last4) { next.aadhaar = ''; next.qrLast4 = d.aadhaar_last4 }
      return next
    })
    toast.success(`Filled from Aadhaar ${d.format}${d.mobile_last4 ? ` · mobile ends ${d.mobile_last4}` : ''}`)
  }

  // ------------------------------------------------------------------ validation + submit

  const patientPayload = () => {
    const out: Vals = {}
    for (const f of ent?.fields ?? []) {
      if (SKIP_KEYS.has(f.key) || f.key === 'id_number' || f.readonly) continue
      if (!isVisible(f.key)) continue
      const val = v[f.key]
      if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && !val.length)) out[f.key] = val
    }
    if (form.photo) out.photo = form.photo
    return out
  }

  const visitPayload = () => {
    if (!v.consulting_doctor) return undefined
    return {
      doctor_id: v.consulting_doctor, department_id: v.visit_department || doctor?.department_id || undefined, visit_type: v.visit_type || 'New',
      priority: v.visit_priority || undefined, chief_complaint: v.chief_complaint || undefined, referral_category: v.referral_category || undefined,
      referral_name: v.referral_name || undefined, remarks: v.referral_remarks || undefined,
    }
  }

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {}
    const all = new Set([...Object.keys(rules), ...FALLBACK_SECTIONS.flatMap((s) => s.fields)])
    for (const key of all) {
      if (!isVisible(key) || !isRequired(key)) continue
      if (VISIT_KEYS.has(key) && !v.consulting_doctor && key !== 'consulting_doctor') continue
      if (key === 'consulting_doctor') continue // visit capture is optional
      if (key === 'age' || key === 'dob') { if (!v.dob) e.dob = 'Enter the date of birth or the age'; continue }
      if (key === 'id_number') { if (!aadhaarDigits && !form.qrLast4) e.id_number = `${label(key)} is required`; continue }
      const val = v[key]
      if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length)) e[key] = `${label(key)} is required`
    }
    for (const k of PHONE_KEYS) if (v[k] && !MOBILE_RE.test(digits(v[k]).slice(-10))) e[k] = 'Enter a 10-digit mobile number'
    if (aadhaarDigits && !aadhaarOk) e.id_number = aadhaarDigits.length === 12 ? 'Not a valid Aadhaar number (checksum)' : 'Aadhaar has 12 digits'
    if (v.pan && !PAN_RE.test(String(v.pan))) e.pan = 'PAN looks like ABCDE1234F'
    if (v.passport_no && !PASSPORT_RE.test(String(v.passport_no))) e.passport_no = 'A letter followed by 7 digits'
    if (v.voter_id && !VOTER_RE.test(String(v.voter_id))) e.voter_id = '3 letters followed by 7 digits'
    if (v.abha_id && digits(v.abha_id).length !== 14) e.abha_id = 'ABHA number has 14 digits'
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v.email))) e.email = 'Enter a valid email'
    if (v.pincode && pin.length !== 6) e.pincode = 'Pincode has 6 digits'
    if (v.chief_complaint && !v.consulting_doctor && isVisible('consulting_doctor')) e.consulting_doctor = 'Choose the consulting doctor for this visit'
    return e
  }

  const save = useMutation({
    mutationFn: (force: boolean) => api<RegisterResult>('/registration/register', {
      method: 'POST',
      body: {
        patient: patientPayload(), age: v.dob ? undefined : form.age, visit: visitPayload(),
        aadhaar: aadhaarOk ? aadhaarDigits : form.qrLast4 ? `XXXXXXXX${form.qrLast4}` : undefined,
        family: settings?.family_tree_enabled && form.family.related_patient ? { related_patient: form.family.related_patient, relationship: form.family.relationship } : undefined,
        fee: settings?.registration_fee_enabled ? { collect: true, mode: fee.mode, reference: fee.reference || undefined } : undefined,
        draft_id: draftId ?? undefined, pre_registration_id: preId ?? undefined, force, override_reason: force ? overrideReason : undefined,
      },
    }),
    onSuccess: (r) => { setResult(r); setBlocking(null); setOverrideReason(''); toast.success(`Registered · UHID ${r.patient.code}`) },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'DUPLICATE' || e.code === 'DUPLICATE_BLOCKED')) {
        setBlocking((e.details?.duplicates as Dup[]) ?? [])
        return
      }
      if (e instanceof ApiError) {
        const fe: Record<string, string> = {}
        for (const [k, msg] of Object.entries(e.fieldErrors)) fe[ERROR_ALIASES[k] ?? k] = msg
        setErrors(fe)
      }
      toast.error(errorMessage(e))
    },
  })

  const submit = () => {
    if (save.isPending) return
    const e = validate()
    setErrors(e)
    if (Object.values(e).some(Boolean)) {
      toast.error('Please fix the highlighted fields')
      const first = Object.keys(e).find((k) => e[k])
      if (first) document.getElementById(`reg-${first}`)?.focus()
      return
    }
    save.mutate(false)
  }

  const draftPayload = () => ({ patient: { ...v, photo: form.photo }, age: form.age, aadhaar: aadhaarDigits || (form.qrLast4 ? `XXXXXXXX${form.qrLast4}` : ''),
    family: form.family, visit: v.consulting_doctor ? { doctor_id: v.consulting_doctor } : undefined })
  const saveDraft = useMutation({
    mutationFn: () => draftId
      ? api<Rec>(`/registration/drafts/${draftId}`, { method: 'PUT', body: { payload: draftPayload() } })
      : api<Rec>('/registration/drafts', { method: 'POST', body: { payload: draftPayload() } }),
    onSuccess: (d) => { setDraftId(d.id); toast.success(`Draft ${d.code} saved — the full Aadhaar number is not kept in drafts`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const resume = async (id: string) => {
    try {
      const d = await api<{ id: string; code: string; payload: { patient?: Vals; age?: Ymd; aadhaar?: string; family?: FormState['family'] } }>(`/registration/drafts/${id}`)
      const p = d.payload ?? {}
      const last4 = digits(p.aadhaar).slice(-4)
      setForm({ v: { ...defaults, ...(p.patient ?? {}) }, age: p.age ?? (p.patient?.dob ? ageFromDob(String(p.patient.dob)) ?? {} : {}), aadhaar: '',
        qrLast4: last4.length === 4 ? last4 : null, photo: (p.patient?.photo as string) ?? null, family: p.family ?? { related_patient: null, relationship: 'Spouse' } })
      setDraftId(d.id)
      setErrors({})
      toast.success(`Resumed draft ${d.code}${last4.length === 4 ? ' — re-scan or re-type the Aadhaar to use it for duplicate checks' : ''}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const loadPre = async (id: string | null) => {
    setPreId(id)
    if (!id) return
    try {
      const r = await api<Rec>(`/m/registration/pre_registrations/${id}`)
      setMany({ first_name: r.first_name, last_name: r.last_name, phone: r.phone, gender: r.gender ?? v.gender, dob: r.dob, email: r.email })
      if (r.dob) setForm((s) => ({ ...s, age: ageFromDob(r.dob) ?? {} }))
      toast.success(`Loaded pre-registration ${r.code}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const reset = () => {
    setForm(blank(defaults))
    setErrors({})
    setDraftId(null)
    setPreId(null)
    setResult(null)
    setFee({ mode: 'CASH', reference: '' })
  }

  // /registration/new?draft=<id> resumes a draft (from the Draft registrations page)
  const draftParam = params.get('draft')
  useEffect(() => {
    if (!ready || !draftParam) return
    void resume(draftParam)
    setParams((p) => { p.delete('draft'); return p }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, draftParam])

  useShortcuts('Register patient', [
    { keys: 'mod+s', label: 'Save & register', run: submit, allowInInput: true },
    { keys: 'alt+d', label: 'Save as draft', run: () => saveDraft.mutate(), allowInInput: true },
    { keys: 'alt+q', label: 'Scan Aadhaar QR', run: () => setScan(true), allowInInput: true },
  ], ready && canWrite && !result)

  // ------------------------------------------------------------------ render

  if (!ent || cfg.isLoading || screen.isLoading) return <Spinner label="Loading the registration form…" />
  if (cfg.error) return <ErrorBox error={cfg.error} />
  if (!canWrite) {
    return (
      <Empty icon="UserPlus" title="Registration is done at the front desk">
        Your role can look patients up but cannot register new ones. Use the patient search (⌘K) to open an existing record.
      </Empty>
    )
  }
  if (result) return <Success result={result} canBill={canBill} onAnother={reset} />

  const sections = (screen.data?.sections?.length ? screen.data.sections : FALLBACK_SECTIONS)
  const bySection = new Map(sections.map((s) => [s.key, s.fields]))
  const opts = cfg.data!.options

  const cell = (key: string): ReactNode => {
    if (!isVisible(key)) return null
    const f = fmap.get(key)
    const err = errors[key]
    const req = isRequired(key)
    const id = `reg-${key}`
    const wrap = (node: ReactNode, extra?: { help?: ReactNode; wide?: boolean }) => (
      <FieldWrap key={key} label={label(key)} required={req} error={err} help={extra?.help} htmlFor={id}
        className={cn((extra?.wide || WIDE.has(key)) && 'sm:col-span-2')}>{node}</FieldWrap>
    )
    switch (key) {
      case 'age':
        return (
          <FieldWrap key={key} label={label(key)} required={req && !v.dob} error={errors.age}>
            <div className="grid grid-cols-3 gap-1.5">
              {(['years', 'months', 'days'] as const).map((p) => (
                <Input key={p} id={p === 'years' ? id : undefined} inputMode="numeric" placeholder={p[0].toUpperCase()} aria-label={`Age ${p}`}
                  value={form.age[p] ?? ''} onChange={(e) => onAge(p, e.target.value)} />
              ))}
            </div>
          </FieldWrap>
        )
      case 'dob':
        return wrap(<Input id={id} type="date" max={new Date().toISOString().slice(0, 10)} value={String(v.dob ?? '')} invalid={!!err} onChange={(e) => onDob(e.target.value)} />)
      case 'id_number':
        return wrap(
          <div className="relative">
            <Input id={id} inputMode="numeric" autoComplete="off" placeholder={form.qrLast4 ? `XXXX XXXX ${form.qrLast4}` : '1234 5678 9012'} value={form.aadhaar}
              invalid={!!err} onChange={(e) => { setForm((s) => ({ ...s, aadhaar: groupAadhaar(e.target.value), qrLast4: digits(e.target.value) ? null : s.qrLast4 })); setErrors((x) => ({ ...x, id_number: '' })) }} />
            {aadhaarOk && <ShieldCheck className="absolute right-2.5 top-2.5 size-4 text-emerald-600" aria-label="Valid Aadhaar" />}
          </div>,
          { help: form.qrLast4 && !aadhaarDigits ? `From Secure QR — ends ${form.qrLast4}` : 'Only the last 4 digits are stored' })
      case 'consulting_doctor':
        return wrap(
          <Select id={id} value={String(v.consulting_doctor ?? '')} invalid={!!err} onChange={(e) => set('consulting_doctor', e.target.value || null)}>
            <option value="">{doctors.isLoading ? 'Loading doctors…' : 'Select…'}</option>
            {doctors.data?.map((d) => (
              <option key={d.id} value={d.id} disabled={!!d.on_leave}>
                {d.name}{d.department ? ` — ${d.department}` : ''}{d.consult_fee ? ` · ₹${d.consult_fee}` : ''}{d.on_leave ? ' (on leave)' : ''}
              </option>
            ))}
          </Select>,
          { help: doctor ? `${doctor.sessions.join(', ') || 'No session today'}${doctor.room ? ` · ${doctor.room}` : ''}` : undefined })
      case 'visit_department':
        return wrap(<RefPicker refName="mdm.departments" value={(v.visit_department as string) ?? null} onChange={(idv) => { set('visit_department', idv); set('consulting_doctor', null) }}
          filter={{ opd_enabled: true }} placeholder="All departments" />)
      case 'visit_type':
        return wrap(<Select id={id} value={String(v.visit_type ?? 'New')} onChange={(e) => set('visit_type', e.target.value)}>{opts.visit_types.map((o) => <option key={o}>{o}</option>)}</Select>)
      case 'chief_complaint':
      case 'referral_remarks':
      case 'current_medications':
      case 'past_history':
        return wrap(<Textarea id={id} rows={2} value={String(v[key] ?? '')} invalid={!!err} onChange={(e) => set(key, e.target.value)} />)
      case 'pincode':
        return wrap(
          <div className="relative">
            <Input id={id} inputMode="numeric" maxLength={6} placeholder="6-digit — autofills below" value={String(v.pincode ?? '')} invalid={!!err}
              onChange={(e) => set('pincode', digits(e.target.value).slice(0, 6))} />
            {pincode.isFetching && <Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-ink-3" />}
          </div>,
          { help: pincode.data ? `${pincode.data.precision === 'exact' ? '' : 'Approx. · '}${[pincode.data.city, pincode.data.district].filter(Boolean).join(', ')}`
            : pincode.error && pin.length === 6 ? 'Not in the directory — fill the address' : undefined })
      case 'area':
        return wrap(
          <>
            <Input id={id} list="reg-areas" value={String(v.area ?? '')} onChange={(e) => set('area', e.target.value)} />
            <datalist id="reg-areas">{pincode.data?.areas.map((a) => <option key={a} value={a} />)}</datalist>
          </>)
      case 'state':
        return wrap(
          <Select id={id} value={String(v.state ?? '')} invalid={!!err} onChange={(e) => set('state', e.target.value || null)}>
            <option value="">Select…</option>
            {[...new Set([...(opts.states ?? []), ...(v.state ? [String(v.state)] : [])])].map((s) => <option key={s}>{s}</option>)}
          </Select>)
      case 'country':
        return wrap(<><Input id={id} list="reg-countries" value={String(v.country ?? '')} onChange={(e) => set('country', e.target.value)} />
          <datalist id="reg-countries">{['India', 'Bangladesh', 'Nepal', 'Sri Lanka', 'Bhutan', 'Maldives', 'Oman', 'UAE', 'Kenya', 'Nigeria', 'Iraq', 'Other'].map((c) => <option key={c} value={c} />)}</datalist></>)
      case 'occupation':
        return wrap(<><Input id={id} list="reg-occupations" value={String(v.occupation ?? '')} onChange={(e) => set('occupation', e.target.value)} />
          <datalist id="reg-occupations">{opts.occupations.map((o) => <option key={o} value={o} />)}</datalist></>)
      case 'tags':
        return wrap(<TagPicker id={id} options={opts.tags} value={(v.tags as string[]) ?? []} onChange={(t) => set('tags', t)} />)
      case 'abha_id':
        return wrap(<Input id={id} inputMode="numeric" placeholder="91-1234-5678-9012" value={groupAbha(String(v.abha_id ?? ''))} invalid={!!err}
          onChange={(e) => set('abha_id', digits(e.target.value).slice(0, 14))} />)
      case 'abha_address':
        return wrap(<Input id={id} placeholder="name@abdm" value={String(v.abha_address ?? '')} invalid={!!err} onChange={(e) => set('abha_address', e.target.value.trim().toLowerCase())} />)
      case 'sponsor':
        return wrap(<RefPicker refName="insurance.payers" value={(v.sponsor as string) ?? null} onChange={(idv) => set('sponsor', idv)} invalid={!!err} placeholder="Corporate / insurer / scheme" />)
    }
    if (PHONE_KEYS.includes(key)) {
      return wrap(<Input id={id} type="tel" inputMode="numeric" maxLength={10} placeholder="10-digit mobile" value={String(v[key] ?? '')} invalid={!!err}
        onChange={(e) => set(key, digits(e.target.value).slice(0, 10))} />)
    }
    if (UPPER_KEYS.has(key)) {
      return wrap(<Input id={id} placeholder={f?.placeholder} value={String(v[key] ?? '')} invalid={!!err} onChange={(e) => set(key, e.target.value.toUpperCase())} />)
    }
    return wrap(<GenericInput id={id} field={f} value={v[key]} invalid={!!err} onChange={(val) => set(key, val)} />)
  }

  const band = (b: (typeof BANDS)[number]) => {
    const keys = b.sections.flatMap((sk) => (SPONSORED_SECTIONS.has(sk) && !sponsored ? [] : bySection.get(sk) ?? []))
    const visible = keys.filter((k) => isVisible(k))
    if (b.key === 'patient' && settings?.family_tree_enabled) visible.push('__family')
    if (!visible.length) return null
    const Icon = b.icon
    return (
      <section key={b.key} className={cn('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
        b.key === 'visit' ? 'border-t-2 border-t-amber-500 lg:max-w-3xl' : 'border-t-2 border-t-brand-700 dark:border-t-brand-400')}>
        <header className="flex items-center gap-2 px-4 pb-1 pt-3 text-sm font-semibold text-ink">
          <Icon className={cn('size-4', b.key === 'visit' ? 'text-amber-600' : 'text-brand-700 dark:text-brand-300')} /> {b.label}
          {b.key === 'visit' && <span className="text-xs font-normal text-ink-3">optional — choose a doctor to check the patient in now</span>}
        </header>
        <div className="grid gap-x-3 gap-y-2.5 px-4 pb-4 pt-2 [grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr))]">
          {keys.map((k) => cell(k))}
          {b.key === 'visit' && isVisible('consulting_doctor') && (
            <FieldWrap label="Priority" htmlFor="reg-visit_priority">
              <Select id="reg-visit_priority" value={String(v.visit_priority ?? '')} onChange={(e) => set('visit_priority', e.target.value || null)}>
                <option value="">Automatic</option>{opts.priorities.map((o) => <option key={o}>{o}</option>)}
              </Select>
            </FieldWrap>
          )}
          {b.key === 'patient' && settings?.family_tree_enabled && (
            <FieldWrap label="Link family member" className="sm:col-span-2" help="Shares the family tree and guarantor details">
              <div className="flex gap-1.5">
                <div className="min-w-0 flex-1">
                  <RefPicker refName="registration.patients" kind="patient" value={form.family.related_patient}
                    onChange={(idv) => setForm((s) => ({ ...s, family: { ...s.family, related_patient: idv } }))} placeholder="Search UHID / name / mobile" />
                </div>
                <Select className="w-32" value={form.family.relationship} aria-label="Relationship"
                  onChange={(e) => setForm((s) => ({ ...s, family: { ...s.family, relationship: e.target.value } }))}>
                  {['Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Brother', 'Sister', 'Grandparent', 'Grandchild', 'Guardian', 'Other'].map((r) => <option key={r}>{r}</option>)}
                </Select>
              </div>
            </FieldWrap>
          )}
        </div>
      </section>
    )
  }

  const dupList = dups.data?.duplicates ?? []
  return (
    <div className="space-y-3">
      <PageHeader
        icon={embedded ? undefined : 'UserPlus'}
        title={embedded ? <span className="text-base">Register patient</span> : 'Register Patient'}
        badge={draftId ? <Badge tone="amber">Draft</Badge> : preId ? <Badge tone="cyan">From pre-registration</Badge> : undefined}
        chrome={!embedded}
        actions={<>
          <PhotoButton value={form.photo} onChange={(idv) => setForm((s) => ({ ...s, photo: idv }))} />
          <Button size="sm" icon="ScanLine" onClick={() => setScan(true)}>Scan Aadhaar</Button>
          <Button size="sm" icon="FilePen" loading={saveDraft.isPending} onClick={() => saveDraft.mutate()}>Save as draft</Button>
          <Button size="sm" icon="Files" onClick={() => setDrafts(true)}>View drafts</Button>
          <Button size="sm" icon="Users" onClick={() => setRegistered(true)}>View registered</Button>
          {reg.canEntity('registration.pre_registrations') && (
            <Popover className="w-80 p-2" trigger={({ toggle }) => <Button size="sm" icon="QrCode" onClick={toggle}>Pre-registration</Button>}>
              <FieldWrap label="Convert a QR / web pre-registration">
                <RefPicker refName="registration.pre_registrations" value={preId} filter={{ status: 'Pending' }} onChange={(idv) => loadPre(idv)} placeholder="Name, mobile or PRE code" />
              </FieldWrap>
            </Popover>
          )}
          <Button size="sm" variant="ghost" className="text-red-600" icon="CircleX" onClick={() => { if (confirm('Clear the form?')) reset() }}>Cancel</Button>
          <Button size="sm" variant="primary" icon="CircleCheck" loading={save.isPending} onClick={submit}>Save & register</Button>
        </>}
      />

      {dupList.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> {dupList.length} existing patient{dupList.length > 1 ? 's' : ''} match — open the existing UHID instead of creating a new one</div>
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {dupList.map((d) => (
              <li key={d.id}>
                <Link to={`/patients/${d.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-xs text-ink ring-1 ring-amber-300 hover:bg-surface-2 dark:ring-amber-500/30">
                  <UserCheck className="size-3.5" /> {d.title} · {d.code} · {d.reasons.join(', ')}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); submit() }} className="space-y-3">
        {BANDS.map(band)}
        {settings?.registration_fee_enabled && (
          <Card className="lg:max-w-3xl" pad={false}>
            <div className="flex flex-wrap items-end gap-3 px-4 py-3">
              <div className="mr-auto">
                <div className="text-sm font-medium text-ink">Registration fee {money(settings.registration_fee_amount)}</div>
                <div className="text-xs text-ink-3">Collected on Save & register — a paid OP bill is created</div>
              </div>
              <FieldWrap label="Mode">
                <Select value={fee.mode} onChange={(e) => setFee({ ...fee, mode: e.target.value })} className="w-32">
                  {['CASH', 'CARD', 'UPI', 'WALLET', 'BANK', 'CHEQUE'].map((m) => <option key={m}>{m}</option>)}
                </Select>
              </FieldWrap>
              {fee.mode !== 'CASH' && (
                <FieldWrap label="Reference" required><Input value={fee.reference} onChange={(e) => setFee({ ...fee, reference: e.target.value })} className="w-44" placeholder="Txn / UTR no." /></FieldWrap>
              )}
            </div>
          </Card>
        )}
        <div className="flex items-center justify-end gap-2 pb-2">
          <span className="mr-auto text-xs text-ink-3">Ctrl/⌘ + S to save · Alt + D draft · Alt + Q scan Aadhaar</span>
          <Button type="button" variant="ghost" onClick={() => { if (confirm('Clear the form?')) reset() }}>Clear</Button>
          <Button type="submit" variant="primary" icon="UserPlus" loading={save.isPending}>Save & register</Button>
        </div>
      </form>

      <AadhaarScanModal open={scan} onClose={() => setScan(false)} onRead={onScanned} />
      <DraftsModal open={drafts} onClose={() => setDrafts(false)} onResume={resume} canWrite={canWrite} />
      <RegisteredModal open={registered} onClose={() => setRegistered(false)} />

      <Modal open={!!blocking} onClose={() => setBlocking(null)} title="This patient may already be registered" size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setBlocking(null)}>Back to the form</Button>
          {settings?.allow_duplicate_override !== false && (
            <Button variant="warning" disabled={overrideReason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate(true)}>Register a new UHID anyway</Button>
          )}
        </>}>
        <p className="mb-3 text-sm text-ink-2">The hospital blocks registration when {(cfg.data?.duplicate_keys ?? []).filter((d) => settings?.duplicate_keys.includes(d.key)).map((d) => d.label.toLowerCase()).join(', ') || 'key details'} match. Open the existing record instead.</p>
        <ul className="space-y-2">
          {blocking?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2.5">
              <div>
                <div className="text-sm font-medium text-ink">{d.title} <span className="font-mono text-xs text-ink-3">{d.code}</span></div>
                <div className="text-xs text-ink-2">{[d.age != null ? `${d.age}y` : null, d.gender, d.phone, d.dob ? `DOB ${fmtDate(d.dob)}` : null, d.registered_at ? `registered ${fmtDate(d.registered_at)}` : null].filter(Boolean).join(' · ')}</div>
                <div className="mt-1 flex flex-wrap gap-1">{d.reasons.map((r) => <Badge key={r} tone="red">{r}</Badge>)}</div>
              </div>
              <Button size="sm" variant="primary" onClick={() => nav(`/patients/${d.id}`)}>Open existing record</Button>
            </li>
          ))}
        </ul>
        {settings?.allow_duplicate_override !== false && (
          <FieldWrap label="Reason for a new UHID (audited)" className="mt-3" required>
            <Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. Same mobile shared by family members" />
          </FieldWrap>
        )}
      </Modal>
    </div>
  )
}

// ------------------------------------------------------------------ pieces

function GenericInput({ id, field, value, onChange, invalid }: { id: string; field?: FieldDef; value: unknown; onChange: (v: unknown) => void; invalid?: boolean }) {
  if (!field) return <Input id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} invalid={invalid} />
  if (field.type === 'select') {
    return (
      <Select id={id} value={String(value ?? '')} invalid={invalid} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Select…</option>{field.options?.map((o) => <option key={o}>{o}</option>)}
      </Select>
    )
  }
  if (field.type === 'boolean') {
    return <label className="flex h-9 items-center gap-2 text-sm text-ink"><input id={id} type="checkbox" className="size-4 accent-brand-700" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> Yes</label>
  }
  if (field.type === 'date') return <Input id={id} type="date" value={String(value ?? '')} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />
  if (field.type === 'number' || field.type === 'percent' || field.type === 'currency') {
    return <Input id={id} type="number" min={field.min} max={field.max} value={value === null || value === undefined ? '' : String(value)} invalid={invalid}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
  }
  if (field.type === 'tags') {
    return <Input id={id} value={Array.isArray(value) ? value.join(', ') : String(value ?? '')} placeholder="Comma separated" invalid={invalid}
      onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />
  }
  if (field.type === 'ref' && field.ref) return <RefPicker refName={field.ref} value={(value as string) ?? null} onChange={(idv) => onChange(idv)} kind={field.kind} invalid={invalid} />
  return <Input id={id} type={field.type === 'email' ? 'email' : 'text'} placeholder={field.placeholder} value={String(value ?? '')} invalid={invalid} onChange={(e) => onChange(e.target.value)} />
}

function TagPicker({ id, options, value, onChange }: { id: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const all = [...new Set([...options, ...value])]
  return (
    <div id={id} className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line-2 bg-surface px-1.5 py-1" role="group" aria-label="Patient tags">
      {all.map((t) => {
        const on = value.includes(t)
        return (
          <button key={t} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== t) : [...value, t])}
            className={cn('rounded-md px-2 py-0.5 text-xs ring-1 ring-inset', on ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface-2 text-ink-2 ring-line hover:text-ink')}>
            {t}
          </button>
        )
      })}
    </div>
  )
}

function Success({ result, canBill, onAnother }: { result: RegisterResult; canBill: boolean; onAnother: () => void }) {
  const nav = useNavigate()
  const reg = useRegistry()
  const p = result.patient
  const visit = result.visit
  const prompt = result.bill_prompt
  return (
    <Card className="mx-auto max-w-2xl">
      <div className="text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <h2 className="mt-2 text-lg font-semibold text-ink">{p.title || fullName(p)}</h2>
        <p className="text-sm text-ink-2">{[p.gender, result.age ? `${result.age.years}y ${result.age.months}m` : null, p.phone].filter(Boolean).join(' · ')}{p.dob_estimated ? ' · DOB estimated from age' : ''}</p>
        <div className="mx-auto mt-3 w-fit rounded-xl border-2 border-dashed border-brand-600/40 px-8 py-3">
          <div className="text-xs uppercase tracking-widest text-ink-3">UHID</div>
          <div className="font-mono text-3xl font-bold tracking-wider text-brand-800 dark:text-brand-300">{p.code}</div>
        </div>
      </div>
      {visit && (
        <div className="mt-4 grid gap-3 rounded-xl bg-surface-2 p-3 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-ink-3">Consulting doctor</div><div className="font-medium text-ink">{visit.doctor.name}</div><div className="text-xs text-ink-2">{visit.doctor.department}</div></div>
          <div><div className="text-xs text-ink-3">Token</div><div className="tabular text-xl font-bold text-ink">{visit.token?.label ?? '—'}</div><div className="text-xs text-ink-2">Slot {String(visit.appointment.slot)}{visit.overbooked ? ' (extra)' : ''}</div></div>
          <div><div className="text-xs text-ink-3">Visit</div><div className="font-medium text-ink">{String(visit.appointment.code)}</div><div className="text-xs text-ink-2">Checked in · {String(visit.appointment.type)}</div></div>
        </div>
      )}
      {result.fee?.invoice && (
        <p className="mt-3 text-center text-sm text-ink-2">Registration fee {money(result.fee.invoice.net)} collected · bill {String(result.fee.invoice.code)}</p>
      )}
      {prompt && canBill && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-600/30 bg-brand-50 px-4 py-3 dark:bg-brand-500/10">
          <div className="text-sm"><div className="font-medium text-ink">Bill the consultation now?</div><div className="text-ink-2">{prompt.description} · {money(prompt.amount)}</div></div>
          <Button variant="primary" icon="Receipt" onClick={() => nav(`/op/billing?patient=${p.id}&charges=${prompt.charge_ids.join(',')}`)}>Bill now</Button>
        </div>
      )}
      {prompt && !canBill && <p className="mt-3 text-center text-sm text-ink-2">The consultation ({money(prompt.amount)}) is waiting to be billed at the OP billing counter.</p>}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button icon="Printer" onClick={() => window.open(`/print/registration/patients/${p.id}`, '_blank')}>Print UHID card</Button>
        {!visit && reg.canPage('appointments', 'booking-desk', 'edit') && <Button icon="CalendarPlus" onClick={() => nav(`/m/appointments/booking-desk?patient=${p.id}`)}>Book appointment</Button>}
        <Button icon="User" onClick={() => nav(`/patients/${p.id}`)}>Open patient</Button>
        <Button variant="primary" icon="UserPlus" onClick={onAnother}>Register another</Button>
      </div>
    </Card>
  )
}

