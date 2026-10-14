import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Button, FieldWrap, Input, Segmented } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { publicPost } from './lib'

interface LoginResult { token: string; expires_at: string; patient: { id: string; name: string; uhid: string } }

const platform = (): 'Web' | 'Android' | 'iOS' => (/android/i.test(navigator.userAgent) ? 'Android' : /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'iOS' : 'Web')

export default function PortalLogin({ onLoggedIn }: { onLoggedIn: (r: LoginResult) => void }) {
  const hospital = useQuery({ queryKey: ['public', 'hospital'], queryFn: () => api<{ name: string }>('/public/hospital'), staleTime: 10 * 60_000 })
  const [by, setBy] = useState<'uhid' | 'mobile'>('mobile')
  const [id, setId] = useState('')
  const [sent, setSent] = useState<{ to: string; dev_otp?: string } | null>(null)
  const [otp, setOtp] = useState('')
  const [needConsent, setNeedConsent] = useState(false)
  const [consent, setConsent] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const subject = by === 'uhid' ? { uhid: id.trim() } : { mobile: id.replace(/\D/g, '') }

  useEffect(() => { document.title = `Patient portal · ${hospital.data?.name ?? 'Hospital'}` }, [hospital.data?.name])
  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])

  const requestOtp = useMutation({
    mutationFn: () => publicPost<{ sent: boolean; to: string; dev_otp?: string }>('/portal/otp', subject),
    onSuccess: (r) => { setSent(r); setErr(null); setOtp(''); setCooldown(30) },
    onError: (e) => setErr(errorMessage(e)),
  })
  const login = useMutation({
    mutationFn: () => publicPost<LoginResult>('/portal/login', { ...subject, otp, consent, platform: platform() }),
    onSuccess: onLoggedIn,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CONSENT_REQUIRED') { setNeedConsent(true); setErr(null); return }
      setErr(errorMessage(e))
    },
  })

  const submitId = (e: FormEvent) => {
    e.preventDefault()
    if (by === 'mobile' && !/^[6-9]\d{9}$/.test(subject.mobile ?? '')) { setErr('Enter your 10-digit mobile number'); return }
    if (by === 'uhid' && !id.trim()) { setErr('Enter your UHID (printed on your hospital card)'); return }
    requestOtp.mutate()
  }
  const submitOtp = (e: FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(otp)) { setErr('Enter the 6-digit OTP'); return }
    if (needConsent && !consent) { setErr('Please give your consent to continue'); return }
    login.mutate()
  }

  return (
    <div className="min-h-full bg-plane">
      <div className="bg-brand-900 px-4 pb-16 pt-8 text-white">
        <div className="mx-auto flex max-w-md items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div>
            <div className="text-lg font-semibold">{hospital.data?.name ?? 'Patient portal'}</div>
            <div className="text-sm text-cyan-100/80">Your appointments, reports and bills — in one place</div>
          </div>
        </div>
      </div>
      <main className="mx-auto -mt-10 w-full max-w-md px-4 pb-10">
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-lg">
          {!sent ? (
            <form onSubmit={submitId} className="space-y-4" noValidate>
              <h1 className="text-xl font-semibold text-ink">Sign in</h1>
              <Segmented value={by} onChange={(k) => { setBy(k); setId(''); setErr(null) }}
                options={[{ key: 'mobile', label: 'Mobile number' }, { key: 'uhid', label: 'UHID' }]} />
              {by === 'mobile' ? (
                <FieldWrap label="Registered mobile number" htmlFor="pl-id" error={err ?? undefined}>
                  <div className="flex">
                    <span className="inline-flex h-11 items-center rounded-l-lg border border-r-0 border-line-2 bg-surface-2 px-3 text-sm text-ink-2">+91</span>
                    <Input id="pl-id" className="h-11 rounded-l-none text-base" inputMode="numeric" autoComplete="tel-national" maxLength={10} autoFocus
                      value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, '').slice(0, 10))} invalid={!!err} />
                  </div>
                </FieldWrap>
              ) : (
                <FieldWrap label="UHID" htmlFor="pl-id" error={err ?? undefined} help="Printed on your hospital card and bills, e.g. UH00001234">
                  <Input id="pl-id" className="h-11 text-base uppercase" autoCapitalize="characters" autoFocus value={id}
                    onChange={(e) => setId(e.target.value.toUpperCase().slice(0, 20))} invalid={!!err} />
                </FieldWrap>
              )}
              <Button type="submit" variant="primary" className="h-11 w-full text-base" loading={requestOtp.isPending}>Get OTP</Button>
            </form>
          ) : (
            <form onSubmit={submitOtp} className="space-y-4" noValidate>
              <button type="button" className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300" onClick={() => { setSent(null); setNeedConsent(false); setErr(null) }}>
                <ChevronLeft className="size-4" /> Change {by === 'uhid' ? 'UHID' : 'number'}
              </button>
              <div>
                <h1 className="text-xl font-semibold text-ink">Enter OTP</h1>
                <p className="text-sm text-ink-2">Sent to {sent.to}. It is valid for 5 minutes.</p>
                {sent.dev_otp && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Development build — OTP {sent.dev_otp}</p>}
              </div>
              <FieldWrap label="One-time password" htmlFor="pl-otp" error={err ?? undefined}>
                <Input id="pl-otp" className="h-12 text-center text-xl tracking-[0.6em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                  value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} invalid={!!err} />
              </FieldWrap>
              {needConsent && (
                <label className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-sm text-ink-2 ring-1 ring-line">
                  <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-brand-700" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>First time here: I consent to {hospital.data?.name ?? 'the hospital'} showing my health records, bills and appointments in this portal and contacting me about my care, as per the Digital Personal Data Protection Act, 2023. I can withdraw this consent at any time.</span>
                </label>
              )}
              <Button type="submit" variant="primary" className="h-11 w-full text-base" loading={login.isPending}>{needConsent ? 'Agree and continue' : 'Verify & sign in'}</Button>
              <Button type="button" variant="ghost" className="w-full" disabled={cooldown > 0} loading={requestOtp.isPending} onClick={() => requestOtp.mutate()}>
                {cooldown > 0 ? `Resend OTP in ${cooldown}s` : 'Resend OTP'}
              </Button>
            </form>
          )}
        </div>
        <p className="mt-4 flex items-start gap-2 px-1 text-xs text-ink-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" /> Never share your OTP. Hospital staff will never ask for it. New patient? <a href="/pre-register" className="text-brand-700 underline dark:text-brand-300">Pre-register here</a>.
        </p>
      </main>
    </div>
  )
}
