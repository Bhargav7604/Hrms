import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Lock, Pencil, Search, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, PageHeader, Select, Spinner, StatusBadge, Tabs, Textarea } from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePages } from '@/lib/pages'
import { readRecent } from '@/layout/CommandPalette'
import type { Level } from '@/lib/types'

interface IndexItem { kind: 'workspace' | 'records'; key: string; label: string; icon: string; route: string; access: Level; restricted?: boolean; shared?: boolean }
interface IndexModule { id: string; no: number; name: string; icon: string; suite: string; summary: string; scope: string; items: IndexItem[] }
interface ModuleIndex { suites: { id: string; name: string; short: string; description?: string }[]; modules: IndexModule[] }
interface Ticket { id: string; code: string; subject: string; category: string; severity: string; status: string; screen?: string; created_at: string; resolution?: string; reporter_name?: string }

const CATEGORIES = ['Question', 'Something is broken', 'Access / permissions', 'Data correction', 'Feature request', 'Training', 'Printer / hardware / network']
const SEVERITIES = ['Low', 'Normal', 'High', 'Critical']

export default function Support() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'ticket' ? 'ticket' : 'index'
  const reg = useRegistry()
  return (
    <div>
      <PageHeader icon="LifeBuoy" title="Support"
        subtitle="An index of every module and screen in Vlack HRMS — and a ticket that reaches the support team with the screen you were on."
        actions={reg.meta?.user.role === 'admin' ? <Link to="/m/mdm/support_tickets" className="text-sm text-brand-700 hover:underline dark:text-brand-300">All tickets →</Link> : undefined} />
      <Tabs className="mb-4" value={tab} onChange={(k) => setParams(k === 'ticket' ? { tab: 'ticket' } : {}, { replace: true })}
        tabs={[{ key: 'index', label: 'Module index', icon: 'LayoutGrid' }, { key: 'ticket', label: 'Raise a ticket', icon: 'Send' }]} />
      {tab === 'index' ? <IndexTab /> : <TicketTab />}
    </div>
  )
}

function AccessBadge({ level }: { level: Level }) {
  if (level === 'edit') return <Badge tone="green"><Pencil className="size-3" /> Edit</Badge>
  if (level === 'view') return <Badge tone="blue"><Eye className="size-3" /> View</Badge>
  return <Badge tone="gray"><Lock className="size-3" /> No access</Badge>
}

function IndexTab() {
  const q = useQuery({ queryKey: ['support', 'modules'], queryFn: () => api<ModuleIndex>('/support/modules'), staleTime: 5 * 60_000 })
  const platform = usePages().filter((p) => p.kind === 'platform' || p.kind === 'admin' || p.kind === 'feature')
  const [f, setF] = useState('')
  const [kind, setKind] = useState<'all' | 'workspace' | 'records'>('all')
  const [mine, setMine] = useState(false)
  const [suite, setSuite] = useState('')
  const needle = f.trim().toLowerCase()
  const modules = useMemo(() => (q.data?.modules ?? []).map((m) => ({
    ...m,
    items: m.items.filter((i) => (kind === 'all' || i.kind === kind) && (!mine || i.access !== 'none') &&
      (!needle || `${m.name} ${m.no} ${i.label} ${i.route}`.toLowerCase().includes(needle))),
  })).filter((m) => m.items.length && (!suite || m.suite === suite)), [q.data, kind, mine, needle, suite])
  const total = q.data?.modules.reduce((n, m) => n + m.items.length, 0) ?? 0
  const shown = modules.reduce((n, m) => n + m.items.length, 0)
  const platformShown = platform.filter((p) => !needle || `${p.label} ${p.path}`.toLowerCase().includes(needle))
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-ink">All modules <span className="font-normal text-ink-3">({shown} shown of {total})</span></h2>
        <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input className="pl-8" placeholder="Filter modules…" value={f} onChange={(e) => setF(e.target.value)} data-list-search="" /></div>
        <Select className="w-44" value={suite} onChange={(e) => setSuite(e.target.value)} aria-label="Suite">
          <option value="">All suites</option>
          {q.data?.suites.map((s) => <option key={s.id} value={s.id}>{s.short}</option>)}
        </Select>
        <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
          {(['all', 'workspace', 'records'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium', kind === k ? 'bg-brand-800 text-white' : 'text-ink-2 hover:text-ink')}>
              {k === 'all' ? 'All' : k === 'workspace' ? 'Workspaces' : 'Record lists'}
            </button>
          ))}
        </div>
        <Button size="sm" variant={mine ? 'primary' : 'secondary'} onClick={() => setMine(!mine)} aria-pressed={mine}>My access</Button>
      </div>
      {!suite && platformShown.length > 0 && kind === 'all' && (
        <section>
          <SectionHead title="Workspace & help" count={platformShown.length} text="Pages every signed-in user has, plus administration for administrators." />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {platformShown.map((p) => <ItemCard key={p.id} icon={p.icon} label={p.label} route={p.path} level="edit" />)}
          </div>
        </section>
      )}
      {modules.length === 0 && <Empty icon="SearchX" title="No modules match the filters" />}
      {(q.data?.suites ?? []).map((s) => {
        const mods = modules.filter((m) => m.suite === s.id)
        if (!mods.length) return null
        return (
          <div key={s.id} className="space-y-3">
            <div className="rounded-lg bg-surface-2 px-3 py-2">
              <div className="text-xs font-bold uppercase tracking-wider text-ink">{s.name}</div>
              {s.description && <p className="text-xs text-ink-2">{s.description}</p>}
            </div>
            {mods.map((m) => (
              <section key={m.id}>
                <SectionHead title={`${String(m.no).padStart(2, '0')} · ${m.name}`} count={m.items.length} text={m.summary} icon={m.icon} />
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {m.items.map((i) => <ItemCard key={i.route} icon={i.icon} label={i.label} route={i.route} level={i.access} kind={i.kind} restricted={i.restricted} />)}
                </div>
              </section>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function SectionHead({ title, count, text, icon }: { title: string; count: number; text?: string; icon?: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">
        {icon && <Icon name={icon} className="size-3.5" />}{title} <span className="font-normal text-ink-3">({count})</span>
      </h3>
      {text && <p className="text-xs text-ink-3 md:ml-auto md:max-w-[60%] md:text-right">{text}</p>}
    </div>
  )
}

function ItemCard({ icon, label, route, level, kind, restricted }: { icon: string; label: string; route: string; level: Level; kind?: string; restricted?: boolean }) {
  const body = (
    <>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', level === 'none' ? 'bg-surface-2 text-ink-3' : 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300')}>
        <Icon name={icon} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">{label}{restricted && <Lock className="size-3 text-red-500" />}</span>
        <span className="block truncate font-mono text-[11px] text-ink-3">{route}{kind === 'records' ? ' · records' : ''}</span>
      </span>
      <AccessBadge level={level} />
    </>
  )
  const cls = 'flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2'
  return level === 'none' ? <div className={cn(cls, 'opacity-70')}>{body}</div> : <Link to={route} className={cn(cls, 'hover:border-brand-600/40')}>{body}</Link>
}

function TicketTab() {
  const qc = useQueryClient()
  const loc = useLocation()
  // the screen the user came from (the support page itself is not useful)
  const from = (loc.state as { from?: string } | null)?.from ?? readRecent().find((p) => !p.startsWith('/support')) ?? loc.pathname
  const [form, setForm] = useState({ category: 'Question', severity: 'Normal', subject: '', description: '', screen: from })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const tickets = useQuery({ queryKey: ['support', 'tickets'], queryFn: () => api<Ticket[]>('/support/tickets') })
  const cfg = useQuery({ queryKey: ['support', 'config'], queryFn: () => api<{ recipients: string[]; hours?: string }>('/support/config') })
  const send = useMutation({
    mutationFn: () => api<Ticket>('/support/tickets', { method: 'POST', body: form }),
    onSuccess: (t) => {
      toast.success(`Ticket ${t.code} sent to the support team`)
      setForm({ ...form, subject: '', description: '' })
      qc.invalidateQueries({ queryKey: ['support', 'tickets'] })
    },
    onError: (e) => { if (e instanceof ApiError) setErrors(e.fieldErrors); toast.error(errorMessage(e)) },
  })
  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card title="Raise a support ticket" icon="Send">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); setErrors({}); send.mutate() }}>
          <FieldWrap label="Category" required>
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </FieldWrap>
          <FieldWrap label="Severity" required help={form.severity === 'Critical' ? 'Critical = patient care or billing is stopped. The on-call team is alerted.' : undefined}>
            <Select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{SEVERITIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </FieldWrap>
          <FieldWrap label="Subject" required error={errors.subject} className="sm:col-span-2">
            <Input value={form.subject} maxLength={200} placeholder="One line — what went wrong?" onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="What happened" required error={errors.description} className="sm:col-span-2">
            <Textarea rows={6} value={form.description} placeholder="The screen you were on, exactly what you clicked, what you expected and what you saw instead."
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Screen" help="Captured automatically — edit if the problem was elsewhere." className="sm:col-span-2">
            <Input className="font-mono text-xs" value={form.screen} onChange={(e) => setForm({ ...form, screen: e.target.value })} />
          </FieldWrap>
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" variant="primary" loading={send.isPending} disabled={form.subject.trim().length < 3 || form.description.trim().length < 5}>
              <Send className="size-4" /> Send ticket
            </Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4">
        <Card title="Where it goes" icon="Inbox">
          <p className="text-sm text-ink-2">Tickets land with the system administrators in Vlack (Master Data › Support Tickets){cfg.data?.recipients.length ? ' and are copied to:' : '.'}</p>
          {cfg.data?.recipients.map((r) => <div key={r} className="mt-1 font-mono text-xs text-ink">{r}</div>)}
          {cfg.data?.hours && <p className="mt-2 text-xs text-ink-3">Response: {cfg.data.hours}</p>}
          <p className="mt-3 text-xs text-ink-3">Include the screen, the exact action you took, and anything you saw on the page — it is the difference between a same-day fix and a week of guessing.</p>
        </Card>
        <Card title="Your recent tickets" icon="History" pad={false}>
          {tickets.isLoading ? <Spinner /> : !tickets.data?.length ? <Empty icon="Inbox" title="No tickets raised yet" /> : (
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-1.5 text-left font-medium">Ticket</th><th className="px-3 py-1.5 text-left font-medium">Subject</th><th className="px-3 py-1.5 text-left font-medium">Status</th></tr></thead>
              <tbody>
                {tickets.data.map((t) => (
                  <tr key={t.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-2"><span className="font-mono text-xs">{t.code}</span><div className="text-[11px] text-ink-3">{dateTime(t.created_at)}</div></td>
                    <td className="px-3 py-2"><div className="text-ink">{t.subject}</div><div className="text-xs text-ink-3">{t.category} · {t.severity}</div>
                      {t.resolution && <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">{t.resolution}</div>}</td>
                    <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
