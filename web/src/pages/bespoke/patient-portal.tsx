import { useQuery } from '@tanstack/react-query'
import { Copy, ExternalLink, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { ChartFrame, Lines } from '@/components/charts'
import { EntityView, useEntity } from '@/components/records'
import { Badge, Button, Card, ErrorBox, Spinner, StatTile } from '@/components/ui'
import { api } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { number } from '@/lib/format'
import { qrPath } from '@/portal/qr'
import { QrCode } from '@/portal/QrCode'
import type { BespokeProps } from './index'

interface Counts { today: number; d30: number; unique_30d: number }
interface Stats {
  accounts: number; active: number; blocked: number; new_30d: number; platforms: Record<string, number>; patients: number
  adoption_pct: number; logins: Counts; otps: Counts; series: { date: string; logins: number; otps: number }[]
  feedback: { d30: number; avg_rating: number | null }; portal_bookings_30d: number
}

function printPoster(hospital: string, links: { title: string; url: string; text: string }[]) {
  const w = window.open('', '_blank', 'width=800,height=1000')
  if (!w) { toast.error('Allow pop-ups to print the poster'); return }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const blocks = links.map((l) => {
    const q = qrPath(l.url)
    return `<section><h2>${esc(l.title)}</h2><svg viewBox="0 0 ${q.size} ${q.size}" width="280" height="280" shape-rendering="crispEdges"><rect width="${q.size}" height="${q.size}" fill="#fff"/><path d="${q.path}" fill="#000"/></svg><p>${esc(l.text)}</p><code>${esc(l.url)}</code></section>`
  }).join('')
  w.document.write(`<!doctype html><html><head><title>${esc(hospital)} — scan to start</title><style>
    body{font-family:system-ui,sans-serif;text-align:center;color:#000;margin:32px} h1{font-size:28px;margin:0 0 24px}
    main{display:flex;gap:48px;justify-content:center;flex-wrap:wrap} section{max-width:320px} h2{font-size:22px}
    p{font-size:15px} code{font-size:11px;color:#333;word-break:break-all}</style></head><body>
    <h1>${esc(hospital)}</h1><main>${blocks}</main>
    <script>window.onload=()=>window.print()</script></body></html>`)
  w.document.close()
}

export default function PatientPortalAdmin({ module }: BespokeProps) {
  const reg = useRegistry()
  const accounts = useEntity('portal.accounts')
  const stats = useQuery({ queryKey: ['x', module.id, 'portal-stats'], queryFn: () => api<Stats>('/portal/admin/stats'), refetchInterval: 60_000 })
  const origin = window.location.origin
  const portalUrl = `${origin}/portal`
  const preRegUrl = `${origin}/pre-register`
  const hospital = reg.meta?.hospital.name ?? 'Hospital'
  const s = stats.data
  const copy = (u: string) => navigator.clipboard?.writeText(u).then(() => toast.success('Link copied'), () => toast.error('Copy failed'))

  return (
    <div className="space-y-4">
      {stats.error && <ErrorBox error={stats.error} />}
      {stats.isLoading && <Spinner />}
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <StatTile label="Portal accounts" value={number(s.accounts)} icon="Smartphone" hint={`${s.active} active · ${s.blocked} blocked`} />
          <StatTile label="Adoption" value={`${s.adoption_pct}%`} icon="TrendingUp" hint={`of ${number(s.patients)} active patients`} />
          <StatTile label="New sign-ups" value={number(s.new_30d)} icon="UserPlus" hint="last 30 days" />
          <StatTile label="Logins today" value={number(s.logins.today)} icon="LogIn" hint={`${number(s.logins.d30)} in 30 d · ${number(s.logins.unique_30d)} patients`} />
          <StatTile label="OTPs sent today" value={number(s.otps.today)} icon="MessageSquareLock" hint={`${number(s.otps.d30)} in 30 days`} />
          <StatTile label="App bookings" value={number(s.portal_bookings_30d)} icon="CalendarCheck" hint="last 30 days" />
          <StatTile label="App feedback" value={number(s.feedback.d30)} icon="Star" hint={s.feedback.avg_rating != null ? `avg ${s.feedback.avg_rating} / 5 · 30 d` : 'last 30 days'} />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {s ? (
          <ChartFrame title="Portal activity" subtitle="Logins and OTPs sent, last 14 days"
            table={{ columns: ['Date', 'Logins', 'OTPs sent'], rows: s.series.map((d) => [d.date, d.logins, d.otps]) }}>
            <Lines data={s.series.map((d) => ({ ...d, day: d.date.slice(5) }))} x="day"
              series={[{ key: 'logins', label: 'Logins' }, { key: 'otps', label: 'OTPs sent' }]} fmt={(v) => String(Math.round(v))} />
          </ChartFrame>
        ) : <div />}
        <Card icon="QrCode" title="Share with patients"
          actions={<Button size="sm" onClick={() => printPoster(hospital, [
            { title: 'Patient app', url: portalUrl, text: 'Appointments, reports, bills and teleconsults — log in with your mobile OTP.' },
            { title: 'Pre-register', url: preRegUrl, text: 'New patient? Register from your phone and skip the queue.' },
          ])}><Printer className="size-4" /> Print poster</Button>}>
          <div className="grid gap-4 sm:grid-cols-2">
            {[{ title: 'Patient portal', url: portalUrl, note: 'Mobile OTP login' }, { title: 'QR pre-registration', url: preRegUrl, note: 'New patients, before the visit' }].map((l) => (
              <div key={l.url} className="flex flex-col items-center gap-2 rounded-xl border border-line p-3 text-center">
                <div className="text-sm font-semibold text-ink">{l.title}</div>
                <QrCode value={l.url} size={132} className="rounded-md ring-1 ring-line" title={`QR code for ${l.title}`} />
                <div className="text-xs text-ink-3">{l.note}</div>
                <div className="flex gap-1">
                  <Button size="xs" onClick={() => copy(l.url)}><Copy className="size-3.5" /> Copy</Button>
                  <Button size="xs" onClick={() => window.open(l.url, '_blank', 'noopener')}><ExternalLink className="size-3.5" /> Open</Button>
                </div>
              </div>
            ))}
          </div>
          {s && Object.keys(s.platforms).length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
              Platforms: {Object.entries(s.platforms).map(([k, v]) => <Badge key={k} tone="gray">{k} {v}</Badge>)}
            </div>
          )}
        </Card>
      </div>

      {accounts && <EntityView entity={accounts} title="Portal accounts" />}
    </div>
  )
}
