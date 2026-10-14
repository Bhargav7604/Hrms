import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, ChevronLeft, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Button, cn, FieldWrap, Input, Select } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { todayISO } from '@/lib/format'
import { QrCode } from '@/portal/QrCode'

/** Public QR pre-registration (/pre-register): mobile OTP → basic details → code for the desk. */

interface Hospital { name: string; departments: { id: string; name: string }[] }
type Step = 'mobile' | 'details' | 'done'

const digits = (s: string) => s.replace(/\D/g, '')

export default function PreRegister() {
  const hospital = useQuery({ queryKey: ['public', 'hospital'], queryFn: () => api<Hospital>('/public/hospital'), staleTime: 10 * 60_000 })
  const [step, setStep] = useState<Step>('mobile')
  const [phone, setPhone] = useState('')
  const [devOtp, setDevOtp] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const [f, setF] = useState({ otp: '', first_name: '', last_name: '', gender: '', dob: '', email: '', preferred_department: '', preferred_date: '' })
  const [consent, setConsent] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<{ code: string; message: string } | null>(null)

  useEffect(() => { if (hospital.data?.name) document.title = `Pre-register · ${hospital.data.name}` }, [hospital.data?.name])
  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])

  const sendOtp = useMutation({
    mutationFn: () => api<{ sent: boolean; dev_otp?: string }>('/public/pre-register/otp', { method: 'POST', body: { phone } }),
    onSuccess: (r) => { setDevOtp(r.dev_otp ?? null); setStep('details'); setCooldown(30); setErrors({}) },
    onError: (e) => setErrors({ phone: errorMessage(e) }),
  })
  const submit = useMutation({
    mutationFn: () => api<{ code: string; message: string }>('/public/pre-register', {
      method: 'POST',
      body: { phone, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) },
    }),
    onSuccess: (r) => { setDone(r); setStep('done') },
    onError: (e) => {
      const fields = e instanceof ApiError ? e.fieldErrors : {}
      setErrors(Object.keys(fields).length ? fields : { form: errorMessage(e) })
    },
  })

  const onMobile = (e: FormEvent) => {
    e.preventDefault()
    if (!/^[6-9]\d{9}$/.test(phone)) { setErrors({ phone: 'Enter your 10-digit mobile number' }); return }
    sendOtp.mutate()
  }
  const onDetails = (e: FormEvent) => {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!/^\d{6}$/.test(f.otp)) err.otp = 'Enter the 6-digit OTP sent to your mobile'
    if (!f.first_name.trim()) err.first_name = 'First name is required'
    if (!f.gender) err.gender = 'Choose one'
    if (f.dob && f.dob > todayISO()) err.dob = 'Date of birth cannot be in the future'
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) err.email = 'Enter a valid email address'
    if (f.preferred_date && f.preferred_date < todayISO()) err.preferred_date = 'Choose today or a later date'
    if (!consent) err.consent = 'Please give consent to continue'
    setErrors(err)
    if (!Object.keys(err).length) submit.mutate()
  }
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))

  return (
    <div className="min-h-full bg-plane px-4 py-6 sm:py-12">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-5 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-ink">{hospital.data?.name ?? 'Hospital'}</div>
            <div className="text-sm text-ink-2">Patient pre-registration</div>
          </div>
        </header>

        <main className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
          {step !== 'done' && (
            <ol className="mb-5 flex items-center gap-2 text-xs" aria-label="Progress">
              {['Mobile', 'Your details'].map((s, i) => {
                const active = (step === 'mobile' ? 0 : 1) >= i
                return (
                  <li key={s} className="flex flex-1 items-center gap-2">
                    <span className={cn('grid size-6 place-items-center rounded-full font-semibold', active ? 'bg-brand-700 text-white' : 'bg-surface-2 text-ink-3 ring-1 ring-line')}>{i + 1}</span>
                    <span className={active ? 'font-medium text-ink' : 'text-ink-3'}>{s}</span>
                  </li>
                )
              })}
            </ol>
          )}

          {step === 'mobile' && (
            <form onSubmit={onMobile} className="space-y-4" noValidate>
              <div>
                <h1 className="text-xl font-semibold text-ink">Save time at the desk</h1>
                <p className="mt-1 text-sm text-ink-2">Fill in your details from your phone. Show the code you get at the registration counter to receive your UHID.</p>
              </div>
              <FieldWrap label="Mobile number" required error={errors.phone} htmlFor="pr-phone">
                <div className="flex">
                  <span className="inline-flex h-11 items-center rounded-l-lg border border-r-0 border-line-2 bg-surface-2 px-3 text-sm text-ink-2">+91</span>
                  <Input id="pr-phone" className="h-11 rounded-l-none text-base" inputMode="numeric" autoComplete="tel-national" maxLength={10} autoFocus
                    value={phone} onChange={(e) => setPhone(digits(e.target.value).slice(0, 10))} invalid={!!errors.phone} placeholder="98765 43210" />
                </div>
              </FieldWrap>
              <Button type="submit" variant="primary" className="h-11 w-full text-base" loading={sendOtp.isPending}>Send OTP</Button>
              <p className="flex items-start gap-2 text-xs text-ink-3"><ShieldCheck className="mt-0.5 size-4 shrink-0" /> We use your mobile number only to verify you and to send hospital updates. Standard SMS rates may apply.</p>
            </form>
          )}

          {step === 'details' && (
            <form onSubmit={onDetails} className="space-y-3" noValidate>
              <button type="button" onClick={() => { setStep('mobile'); setF((s) => ({ ...s, otp: '' })) }} className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
                <ChevronLeft className="size-4" /> +91 {phone}
              </button>
              <FieldWrap label="OTP" required error={errors.otp} htmlFor="pr-otp"
                help={devOtp ? `Development build — your OTP is ${devOtp}` : 'Sent by SMS. Valid for 5 minutes.'}>
                <div className="flex gap-2">
                  <Input id="pr-otp" className="h-11 text-center text-lg tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                    value={f.otp} onChange={(e) => set('otp')(digits(e.target.value).slice(0, 6))} invalid={!!errors.otp} />
                  <Button type="button" variant="secondary" className="h-11 shrink-0" disabled={cooldown > 0} loading={sendOtp.isPending} onClick={() => sendOtp.mutate()}>
                    {cooldown > 0 ? `Resend ${cooldown}s` : 'Resend'}
                  </Button>
                </div>
              </FieldWrap>
              <div className="grid grid-cols-2 gap-3">
                <FieldWrap label="First name" required error={errors.first_name}>
                  <Input className="h-11" autoComplete="given-name" value={f.first_name} onChange={(e) => set('first_name')(e.target.value)} invalid={!!errors.first_name} />
                </FieldWrap>
                <FieldWrap label="Last name">
                  <Input className="h-11" autoComplete="family-name" value={f.last_name} onChange={(e) => set('last_name')(e.target.value)} />
                </FieldWrap>
              </div>
              <FieldWrap label="Gender" required error={errors.gender}>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Gender">
                  {['Female', 'Male', 'Other'].map((g) => (
                    <button key={g} type="button" role="radio" aria-checked={f.gender === g} onClick={() => set('gender')(g)}
                      className={cn('h-11 rounded-lg border text-sm font-medium', f.gender === g ? 'border-brand-700 bg-brand-700 text-white' : 'border-line-2 bg-surface text-ink-2 hover:bg-surface-2')}>
                      {g}
                    </button>
                  ))}
                </div>
              </FieldWrap>
              <div className="grid grid-cols-2 gap-3">
                <FieldWrap label="Date of birth" error={errors.dob}>
                  <Input type="date" className="h-11" max={todayISO()} value={f.dob} onChange={(e) => set('dob')(e.target.value)} invalid={!!errors.dob} />
                </FieldWrap>
                <FieldWrap label="Email" error={errors.email}>
                  <Input type="email" className="h-11" autoComplete="email" value={f.email} onChange={(e) => set('email')(e.target.value)} invalid={!!errors.email} />
                </FieldWrap>
              </div>
              <FieldWrap label="Department you want to visit">
                <Select className="h-11" value={f.preferred_department} onChange={(e) => set('preferred_department')(e.target.value)}>
                  <option value="">Not sure / General</option>
                  {hospital.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </FieldWrap>
              <FieldWrap label="Preferred visit date" error={errors.preferred_date}>
                <Input type="date" className="h-11" min={todayISO()} value={f.preferred_date} onChange={(e) => set('preferred_date')(e.target.value)} invalid={!!errors.preferred_date} />
              </FieldWrap>
              <label className="flex items-start gap-2 text-sm text-ink-2">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-brand-700" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>I agree that {hospital.data?.name ?? 'the hospital'} may use these details to register me and contact me about my visit (Digital Personal Data Protection Act, 2023).</span>
              </label>
              {errors.consent && <p className="text-xs text-red-600">{errors.consent}</p>}
              {errors.form && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{errors.form}</p>}
              <Button type="submit" variant="primary" className="h-11 w-full text-base" loading={submit.isPending}>Submit</Button>
            </form>
          )}

          {step === 'done' && done && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
              <div>
                <h1 className="text-xl font-semibold text-ink">You're pre-registered</h1>
                <p className="mt-1 text-sm text-ink-2">{done.message}</p>
              </div>
              <div className="rounded-xl border border-dashed border-line-2 bg-surface-2 p-4">
                <div className="text-xs font-medium uppercase tracking-widest text-ink-3">Your code</div>
                <div className="tabular my-1 font-mono text-4xl font-bold tracking-wider text-ink">{done.code}</div>
                <QrCode value={done.code} size={148} className="mx-auto mt-2 rounded-md" title={`Pre-registration code ${done.code}`} />
              </div>
              <p className="text-xs text-ink-3">Take a screenshot of this screen. Carry a photo ID (Aadhaar, PAN, passport or voter ID) to the registration counter.</p>
            </div>
          )}
        </main>
        <p className="mt-4 text-center text-xs text-ink-3">In an emergency, go straight to the Emergency department.</p>
      </div>
    </div>
  )
}
