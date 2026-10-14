import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarPlus, ChevronRight, FileSignature, FileText, MessageSquareHeart, Pill, ReceiptIndianRupee, Video } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Badge, ErrorBox, Spinner, StatusBadge } from '@/components/ui'
import { date, dateTime, money } from '@/lib/format'
import { allowed, firstName, papi, SCOPES, usePortal, type Appt, type Home as HomeData } from './lib'

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </header>
      <div>{children}</div>
    </section>
  )
}

export function ApptCard({ a, children }: { a: Appt; children?: ReactNode }) {
  const d = new Date(`${a.date}T00:00:00`)
  return (
    <div className="flex gap-3 px-4 py-3">
      <div className="flex w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-brand-50 py-1.5 text-brand-800 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-200">
        <span className="text-[11px] font-semibold uppercase">{d.toLocaleDateString('en-IN', { month: 'short' })}</span>
        <span className="tabular text-xl font-bold leading-none">{d.getDate()}</span>
        <span className="text-[11px]">{d.toLocaleDateString('en-IN', { weekday: 'short' })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{a.slot}</span>
          <StatusBadge status={a.status} />
          {a.type === 'Teleconsult' && <Badge tone="violet">Video</Badge>}
        </div>
        <div className="truncate text-sm text-ink">{a.doctor}</div>
        <div className="truncate text-xs text-ink-3">{[a.department, a.token_no ? `Token ${a.token_no}` : null, a.type].filter(Boolean).join(' · ')}</div>
        {children}
      </div>
    </div>
  )
}

export function Home() {
  const { pid, profile } = usePortal()
  const q = useQuery({ queryKey: ['portal', pid, 'home'], queryFn: () => papi<HomeData>('/home', { query: { pid } }) })
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  const h = q.data!
  const tiles = [
    { to: '/portal/appointments/book', label: 'Book a visit', icon: CalendarPlus, scope: SCOPES.appointments },
    { to: '/portal/reports', label: 'Reports', icon: FileText, scope: SCOPES.reports },
    { to: '/portal/bills', label: 'Bills', icon: ReceiptIndianRupee, scope: SCOPES.bills },
    { to: '/portal/prescriptions', label: 'Medicines', icon: Pill, scope: SCOPES.rx },
    { to: '/portal/teleconsults', label: 'Video consult', icon: Video, scope: SCOPES.tele },
    { to: '/portal/feedback', label: 'Feedback', icon: MessageSquareHeart, scope: null },
  ].filter((t) => !t.scope || allowed(profile, t.scope))

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">{profile.self ? `Namaste, ${firstName(profile.name)}` : profile.name}</h1>
        <p className="text-sm text-ink-2">UHID {profile.uhid}{profile.age != null ? ` · ${profile.age} years` : ''}{profile.gender ? ` · ${profile.gender}` : ''}</p>
      </div>

      {!!h.consents_pending && (
        <Link to="/portal/consents" className="flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <FileSignature className="size-6 shrink-0" />
          <span className="flex-1 text-sm"><b>{h.consents_pending} consent form{h.consents_pending > 1 ? 's' : ''}</b> waiting for your signature</span>
          <ChevronRight className="size-5" />
        </Link>
      )}

      {h.teleconsults?.map((t) => (
        <Link key={t.id} to="/portal/teleconsults" className="flex items-center gap-3 rounded-2xl border border-violet-300 bg-violet-50 px-4 py-3 text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200">
          <Video className="size-6 shrink-0" />
          <span className="flex-1 text-sm">Video consultation with <b>{t.doctor}</b> · {dateTime(t.scheduled_at)}{t.can_join ? ' — you can join now' : ''}</span>
          <ChevronRight className="size-5" />
        </Link>
      ))}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to} className="flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-surface px-2 py-3 text-center text-xs font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-brand-600/40">
            <span className="grid size-10 place-items-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><t.icon className="size-5" /></span>
            {t.label}
          </Link>
        ))}
      </div>

      {h.upcoming && (
        <Section title="Upcoming visits" action={<Link to="/portal/appointments" className="text-sm text-brand-700 dark:text-brand-300">All</Link>}>
          {h.upcoming.length === 0 ? (
            <div className="px-4 py-5 text-center text-sm text-ink-2">No upcoming appointments. <Link to="/portal/appointments/book" className="font-medium text-brand-700 underline dark:text-brand-300">Book one</Link></div>
          ) : <div className="divide-y divide-line">{h.upcoming.map((a) => <ApptCard key={a.id} a={a} />)}</div>}
        </Section>
      )}

      {h.dues && (
        <Section title="Bills" action={<Link to="/portal/bills" className="text-sm text-brand-700 dark:text-brand-300">View</Link>}>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-xs text-ink-3">Amount due</div>
              <div className={`tabular text-2xl font-semibold ${h.dues.outstanding > 0 ? 'text-red-700 dark:text-red-300' : 'text-ink'}`}>{money(h.dues.outstanding)}</div>
            </div>
            <div className="text-right text-xs text-ink-2">{h.dues.open_bills ? `${h.dues.open_bills} open bill${h.dues.open_bills > 1 ? 's' : ''}` : 'All bills settled'}<br />Pay at any billing counter (cash, card or UPI)</div>
          </div>
        </Section>
      )}

      {h.reports && (
        <Section title="Latest reports" action={<Link to="/portal/reports" className="text-sm text-brand-700 dark:text-brand-300">All</Link>}>
          {h.reports.length === 0 ? <div className="px-4 py-5 text-center text-sm text-ink-2">No reports yet.</div> : (
            <ul className="divide-y divide-line">
              {h.reports.map((r) => (
                <li key={r.id}>
                  <Link to={`/portal/reports/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <FileText className="size-5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{r.test}</span>
                      <span className="block text-xs text-ink-3">{date(r.verified_at)}</span>
                    </span>
                    {r.critical ? <Badge tone="red"><AlertTriangle className="size-3" /> Critical</Badge> : r.abnormal ? <Badge tone="amber">{r.abnormal} out of range</Badge> : <Badge tone="green">Normal</Badge>}
                    <ChevronRight className="size-4 text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  )
}
