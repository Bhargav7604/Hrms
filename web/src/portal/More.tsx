import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronRight, FileSignature, LogOut, MessageSquareHeart, Pill, Star, User, Users, Video } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Avatar, Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, Segmented, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { date, dateTime, money } from '@/lib/format'
import { Section } from './Home'
import { allowed, papi, SCOPES, usePortal, type Me, type Tele } from './lib'

export function MoreMenu() {
  const { profile, logout } = usePortal()
  const items = [
    { to: '/portal/prescriptions', label: 'Prescriptions', icon: Pill, show: allowed(profile, SCOPES.rx) },
    { to: '/portal/consents', label: 'Consent forms', icon: FileSignature, show: allowed(profile, SCOPES.consent) },
    { to: '/portal/teleconsults', label: 'Video consultations', icon: Video, show: allowed(profile, SCOPES.tele) },
    { to: '/portal/feedback', label: 'Share feedback', icon: MessageSquareHeart, show: true },
    { to: '/portal/profile', label: 'My profile & family', icon: User, show: true },
  ].filter((i) => i.show)
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">More</h1>
      <Section title="Services">
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.to}>
              <Link to={i.to} className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-2">
                <i.icon className="size-5 text-brand-700 dark:text-brand-300" />
                <span className="flex-1 text-sm font-medium text-ink">{i.label}</span>
                <ChevronRight className="size-4 text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
      <Button variant="secondary" className="h-11 w-full" onClick={logout}><LogOut className="size-4" /> Sign out</Button>
    </div>
  )
}

export function Teleconsults() {
  const { pid, profile } = usePortal()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['portal', pid, 'tele'], queryFn: () => papi<Tele[]>('/teleconsults', { query: { pid } }), refetchInterval: 60_000 })
  const join = useMutation({
    mutationFn: (t: Tele) => papi<{ meeting_link: string; status: string }>(`/teleconsults/${t.id}/join`, { method: 'POST', query: { pid } }),
    onSuccess: (r) => { window.open(r.meeting_link, '_blank', 'noopener'); qc.invalidateQueries({ queryKey: ['portal', pid, 'tele'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">Video consultations</h1>
        {allowed(profile, SCOPES.appointments) && <Link to="/portal/appointments/book" className="text-sm font-medium text-brand-700 dark:text-brand-300">Book</Link>}
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data?.length === 0 && <div className="rounded-2xl border border-line bg-surface"><Empty icon="Video" title="No video consultations">Book a visit and choose "Video consultation".</Empty></div>}
      {q.data?.map((t) => (
        <Section key={t.id} title={`${dateTime(t.scheduled_at)} · ${t.doctor ?? 'Doctor'}`} action={<StatusBadge status={t.status} />}>
          <div className="space-y-2 px-4 py-3 text-sm">
            <div className="text-ink-2">{[t.consult_type, t.mode, t.fee ? `fee ${money(t.fee, true)}` : null, t.payment_status ? `payment ${t.payment_status.toLowerCase()}` : null].filter(Boolean).join(' · ')}</div>
            {['Scheduled', 'Waiting', 'In Call'].includes(t.status) && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" className="h-11" disabled={!t.can_join && t.status !== 'In Call'} loading={join.isPending && join.variables?.id === t.id} onClick={() => join.mutate(t)}>
                  <Video className="size-4" /> Join video call
                </Button>
                {t.join_hint && <span className="text-xs text-ink-3">{t.join_hint}</span>}
              </div>
            )}
            {t.status === 'Waiting' && <p className="text-xs text-ink-2">You are in the waiting room. The doctor will start the call shortly — keep the video window open.</p>}
            {t.advice && <p className="whitespace-pre-wrap text-ink"><b>Advice:</b> {t.advice}</p>}
            {t.follow_up_date && <p className="text-ink-2">Follow-up on {date(t.follow_up_date)}</p>}
            <p className="text-xs text-ink-3">Have your old prescriptions and reports ready. Use a quiet place with good network. Teleconsultations follow the Telemedicine Practice Guidelines, 2020.</p>
          </div>
        </Section>
      ))}
    </div>
  )
}

function Stars({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-ink-2">{label}</span>
      <div className="flex" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onChange(n)} className="p-1">
            <Star className={cn('size-7', value >= n ? 'fill-amber-400 text-amber-400' : 'text-line-2')} />
          </button>
        ))}
      </div>
    </div>
  )
}

export function Feedback() {
  const { pid } = usePortal()
  const [visit, setVisit] = useState<'OP' | 'IP' | 'ER' | 'Day Care'>('OP')
  const [rating, setRating] = useState(0)
  const [nps, setNps] = useState<number | null>(null)
  const [sub, setSub] = useState({ rating_doctor: 0, rating_nursing: 0, rating_front_office: 0, rating_billing: 0, rating_cleanliness: 0 })
  const [comments, setComments] = useState('')
  const [callback, setCallback] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: () => papi<{ code: string; message: string }>('/feedback', {
      method: 'POST', query: { pid },
      body: { visit_type: visit, rating, nps: nps ?? undefined, comments: comments || undefined, callback_requested: callback,
              ...Object.fromEntries(Object.entries(sub).filter(([, v]) => v > 0)) },
    }),
    onSuccess: (r) => setDone(r.code),
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (done) {
    return (
      <div className="space-y-3 rounded-2xl border border-line bg-surface p-6 text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <h1 className="text-xl font-semibold text-ink">Thank you</h1>
        <p className="text-sm text-ink-2">Your feedback ({done}) reaches our patient-experience team.{callback ? ' We will call you back.' : ''}</p>
        <Link to="/portal" className="text-sm font-medium text-brand-700 dark:text-brand-300">Back to home</Link>
      </div>
    )
  }
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!rating) { toast.error('Please give an overall rating'); return } send.mutate() }}>
      <h1 className="text-xl font-semibold text-ink">How was your visit?</h1>
      <Segmented value={visit} onChange={setVisit} options={[{ key: 'OP', label: 'OPD' }, { key: 'IP', label: 'Admission' }, { key: 'ER', label: 'Emergency' }, { key: 'Day Care', label: 'Day care' }]} />
      <Section title="Overall">
        <div className="space-y-3 p-4">
          <Stars label="Overall experience *" value={rating} onChange={setRating} />
          <div>
            <div className="mb-1 text-sm text-ink-2">How likely are you to recommend us to family and friends?</div>
            <div className="grid grid-cols-11 gap-1">
              {Array.from({ length: 11 }, (_, n) => (
                <button key={n} type="button" aria-pressed={nps === n} onClick={() => setNps(n)}
                  className={cn('tabular h-9 rounded-md border text-sm', nps === n ? 'border-brand-700 bg-brand-700 text-white' : 'border-line-2 bg-surface text-ink-2')}>{n}</button>
              ))}
            </div>
            <div className="mt-0.5 flex justify-between text-[11px] text-ink-3"><span>Not likely</span><span>Very likely</span></div>
          </div>
        </div>
      </Section>
      <Section title="Rate us on (optional)">
        <div className="space-y-1 p-4">
          {([['rating_doctor', 'Doctor'], ['rating_nursing', 'Nursing care'], ['rating_front_office', 'Front office'], ['rating_billing', 'Billing & waiting time'], ['rating_cleanliness', 'Cleanliness']] as const).map(([k, l]) => (
            <Stars key={k} label={l} value={sub[k]} onChange={(n) => setSub((s) => ({ ...s, [k]: n }))} />
          ))}
        </div>
      </Section>
      <FieldWrap label="Comments">
        <Textarea rows={4} maxLength={3000} value={comments} onChange={(e) => setComments(e.target.value)} placeholder="What went well? What can we improve?" />
      </FieldWrap>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" className="size-4 accent-brand-700" checked={callback} onChange={(e) => setCallback(e.target.checked)} /> Please call me back about this
      </label>
      <Button type="submit" variant="primary" className="h-11 w-full text-base" loading={send.isPending}>Send feedback</Button>
    </form>
  )
}

const RELATIONS = ['Spouse', 'Parent', 'Child', 'Sibling', 'Relative', 'Friend', 'Other']
const LANGS = ['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Gujarati', 'Odia']
const PREFS = ['SMS', 'WhatsApp', 'Email'] as const

export function ProfilePage() {
  const { me, logout } = usePortal()
  const qc = useQueryClient()
  const p = me.patient
  const str = (k: string) => (p[k] == null ? '' : String(p[k]))
  const [f, setF] = useState({
    email: str('email'), address: str('address'), city: str('city'), state: str('state'), pincode: str('pincode'),
    emergency_contact_name: str('emergency_contact_name'), emergency_contact_phone: str('emergency_contact_phone'),
    emergency_contact_relation: str('emergency_contact_relation'),
    preferred_language: me.account.preferred_language || 'English',
  })
  const [prefs, setPrefs] = useState<string[]>(me.account.notification_prefs ?? ['SMS', 'WhatsApp'])
  const [mobile, setMobile] = useState('')
  const [mobileOtp, setMobileOtp] = useState<{ sent: boolean; dev?: string } | null>(null)
  const [otp, setOtp] = useState('')
  const save = useMutation({
    mutationFn: () => papi<Me>('/profile', {
      method: 'PUT',
      body: { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()])), notification_prefs: prefs },
    }),
    onSuccess: (r) => { qc.setQueryData(['portal', 'me'], r); toast.success('Profile updated') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const changeMobile = useMutation({
    mutationFn: (withOtp: boolean) => papi<Me & { sent?: boolean; dev_otp?: string }>('/profile/mobile', { method: 'POST', body: { mobile, otp: withOtp ? otp : undefined } }),
    onSuccess: (r, withOtp) => {
      if (!withOtp) { setMobileOtp({ sent: true, dev: r.dev_otp }); return }
      qc.setQueryData(['portal', 'me'], r); setMobile(''); setOtp(''); setMobileOtp(null); toast.success('Mobile number updated')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Avatar name={p.title} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-ink">{p.title}</h1>
          <p className="text-sm text-ink-2"><span className="font-mono">{p.code}</span>{p.age != null ? ` · ${p.age} y` : ''}{p.gender ? ` · ${p.gender}` : ''}{p.blood_group ? ` · ${p.blood_group}` : ''}</p>
        </div>
      </div>

      <Section title="Contact details">
        <form className="grid gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <FieldWrap label="Mobile (login)" className="sm:col-span-2" help="To change it, verify the new number below."><Input value={str('phone')} disabled className="h-11" /></FieldWrap>
          <FieldWrap label="Email"><Input type="email" className="h-11" value={f.email} onChange={set('email')} /></FieldWrap>
          <FieldWrap label="Preferred language">
            <Select className="h-11" value={f.preferred_language} onChange={set('preferred_language')}>{LANGS.map((l) => <option key={l}>{l}</option>)}</Select>
          </FieldWrap>
          <FieldWrap label="Address" className="sm:col-span-2"><Textarea rows={2} value={f.address} onChange={set('address')} /></FieldWrap>
          <FieldWrap label="City"><Input className="h-11" value={f.city} onChange={set('city')} /></FieldWrap>
          <div className="grid grid-cols-2 gap-3">
            <FieldWrap label="State"><Input className="h-11" value={f.state} onChange={set('state')} /></FieldWrap>
            <FieldWrap label="PIN code"><Input className="h-11" inputMode="numeric" maxLength={6} value={f.pincode} onChange={(e) => setF((s) => ({ ...s, pincode: e.target.value.replace(/\D/g, '') }))} /></FieldWrap>
          </div>
          <FieldWrap label="Emergency contact"><Input className="h-11" value={f.emergency_contact_name} onChange={set('emergency_contact_name')} /></FieldWrap>
          <div className="grid grid-cols-2 gap-3">
            <FieldWrap label="Their phone"><Input className="h-11" type="tel" value={f.emergency_contact_phone} onChange={set('emergency_contact_phone')} /></FieldWrap>
            <FieldWrap label="Relation">
              <Select className="h-11" value={f.emergency_contact_relation} onChange={set('emergency_contact_relation')}>
                <option value="">—</option>{RELATIONS.map((r) => <option key={r}>{r}</option>)}
              </Select>
            </FieldWrap>
          </div>
          <FieldWrap label="Send me updates by" className="sm:col-span-2">
            <div className="flex flex-wrap gap-2">
              {PREFS.map((pr) => (
                <label key={pr} className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm', prefs.includes(pr) ? 'border-brand-700 bg-brand-50 text-ink dark:bg-brand-500/10' : 'border-line-2 text-ink-2')}>
                  <input type="checkbox" className="size-4 accent-brand-700" checked={prefs.includes(pr)} onChange={(e) => setPrefs((s) => (e.target.checked ? [...s, pr] : s.filter((x) => x !== pr)))} /> {pr}
                </label>
              ))}
            </div>
          </FieldWrap>
          <div className="sm:col-span-2"><Button type="submit" variant="primary" className="h-11 w-full sm:w-auto" loading={save.isPending}>Save changes</Button></div>
        </form>
      </Section>

      <Section title="Change mobile number">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); changeMobile.mutate(!!mobileOtp) }}>
          <FieldWrap label="New mobile number">
            <Input className="h-11" inputMode="numeric" maxLength={10} value={mobile} disabled={!!mobileOtp}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          </FieldWrap>
          {mobileOtp && (
            <FieldWrap label="OTP sent to the new number" help={mobileOtp.dev ? `Development build — OTP ${mobileOtp.dev}` : 'Valid for 5 minutes'}>
              <Input className="h-11 tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </FieldWrap>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={mobile.length !== 10 || (!!mobileOtp && otp.length !== 6)} loading={changeMobile.isPending}>{mobileOtp ? 'Verify & update' : 'Send OTP'}</Button>
            {mobileOtp && <Button type="button" variant="ghost" onClick={() => { setMobileOtp(null); setOtp('') }}>Cancel</Button>}
          </div>
        </form>
      </Section>

      <Section title="Family & delegate access" action={<Users className="size-4 text-ink-3" />}>
        <ul className="divide-y divide-line">
          {me.profiles.map((pr) => (
            <li key={pr.id} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar name={pr.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{pr.name}</span>
                <span className="block truncate text-xs text-ink-3">{pr.uhid} · {pr.relation}</span>
              </span>
              {pr.scopes.includes('Full access') ? <Badge tone="green">Full</Badge> : <Badge tone="amber">{pr.scopes.length} areas</Badge>}
            </li>
          ))}
        </ul>
        <p className="px-4 pb-3 text-xs text-ink-3">To add a family member or caregiver, visit the registration desk with ID proof of the relationship.</p>
      </Section>

      {me.account.dpdp_consent_at && <p className="text-xs text-ink-3">Data-processing consent given on {dateTime(me.account.dpdp_consent_at)}. To withdraw it or request deletion of your data, contact the help desk.</p>}
      <Button variant="secondary" className="h-11 w-full" onClick={logout}><LogOut className="size-4" /> Sign out</Button>
    </div>
  )
}

