import { useQuery } from '@tanstack/react-query'
import { Building2, CalendarDays, Maximize2, Minimize2, Printer, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { RecordDrawer, useEntity } from '@/components/records'
import { Badge, Button, cn, Empty, ErrorBox, Input, Select, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { date, moneyShort, number, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { DrillDrawer } from './DrillDrawer'
import { KpiTile, pctText, useAssetAccess } from './parts'
import { ComplianceTab, DueTab, FinanceTab, MaintenanceTab, OverviewTab, RegisterTab, type TabProps } from './tabs'
import type { CompareKey, Dashboard, DashParams, DueWindow, OpenRecord, PeriodKey } from './types'

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'this_fy', label: 'This FY' }, { key: 'last_fy', label: 'Last FY' }, { key: 'this_quarter', label: 'This quarter' },
  { key: 'this_month', label: 'This month' }, { key: 'last_30', label: 'Last 30 days' }, { key: 'custom', label: 'Custom range' },
]
const COMPARES: { key: CompareKey; label: string }[] = [
  { key: 'none', label: 'No comparison' }, { key: 'previous', label: 'Previous period' }, { key: 'last_year', label: 'Same period last year' },
]
const AUTO = [0, 1, 5, 15]
const AUTO_KEY = 'vlack.assets.autorefresh'
type TabKey = 'overview' | 'due' | 'maintenance' | 'compliance' | 'register' | 'finance'

const readAuto = () => { try { const n = Number(localStorage.getItem(AUTO_KEY)); return AUTO.includes(n) ? n : 0 } catch { return 0 } }
const writeAuto = (n: number) => { try { localStorage.setItem(AUTO_KEY, String(n)) } catch { /* storage unavailable */ } }

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function span(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00`), b = new Date(`${to}T00:00:00`)
  const sameYear = a.getFullYear() === b.getFullYear()
  const fmt = (d: Date, y: boolean) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' } : {}) })
  return `${fmt(a, !sameYear)} – ${fmt(b, true)}`
}

function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const h = () => setOn(document.fullscreenElement === ref.current && !!ref.current)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [ref])
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void ref.current?.requestFullscreen?.()
  }, [ref])
  const exit = useCallback(() => { if (document.fullscreenElement) void document.exitFullscreen() }, [])
  return { on, toggle, exit, supported: typeof document !== 'undefined' && !!document.fullscreenEnabled }
}

/** Asset management dashboard. `embedded` = inside the Assets module page; otherwise the full /assets/dashboard screen. */
export default function AssetDashboard({ embedded = false }: { embedded?: boolean }) {
  const access = useAssetAccess()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const rootRef = useRef<HTMLDivElement>(null)
  const fs = useFullscreen(rootRef)

  const [period, setPeriod] = useState<PeriodKey>('this_fy')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [compare, setCompare] = useState<CompareKey>('none')
  const [win, setWin] = useState<DueWindow>(30)
  const [auto, setAuto] = useState<number>(readAuto)
  const [drill, setDrill] = useState<{ bucket: string; title: string } | null>(null)
  const [openRec, setOpenRec] = useState<(OpenRecord & { back?: { bucket: string; title: string } }) | null>(null)

  const customOk = period !== 'custom' || (!!from && !!to && from <= to)
  const dash: DashParams = { period, compare, window: win, ...(period === 'custom' ? { date_from: from, date_to: to } : {}) }
  const q = useQuery({
    queryKey: ['x', 'assets', 'dashboard', dash],
    queryFn: () => api<Dashboard>('/assets/dashboard', { query: { ...dash } }),
    enabled: access.dashboard && customOk,
    placeholderData: (p) => p,
    refetchInterval: auto ? auto * 60_000 : false,
    refetchIntervalInBackground: false,
  })
  const d = q.data

  const entities = {
    'assets.assets': useEntity('assets.assets'),
    'assets.breakdowns': useEntity('assets.breakdowns'),
    'assets.pm_jobs': useEntity('assets.pm_jobs'),
    'assets.transfers': useEntity('assets.transfers'),
  }

  const tabParam = params.get('tab') as TabKey | null
  const tabs: { key: TabKey; label: string; icon: string; alert?: number }[] = [
    { key: 'overview', label: 'Overview', icon: 'LayoutGrid' },
    { key: 'due', label: 'Due & Expiring', icon: 'CalendarClock', alert: d?.alerts.due },
    { key: 'maintenance', label: 'Maintenance', icon: 'Wrench', alert: d?.alerts.maintenance },
    { key: 'compliance', label: 'Compliance & Cover', icon: 'ShieldCheck', alert: d?.alerts.compliance },
    { key: 'register', label: 'Register & Movement', icon: 'Boxes', alert: d?.alerts.register },
    ...(access.finance && (!d || d.finance) ? [{ key: 'finance' as TabKey, label: 'Finance', icon: 'IndianRupee' }] : []),
  ]
  const tab: TabKey = tabs.some((t) => t.key === tabParam) ? tabParam! : 'overview'
  const goTab = useCallback((k: string) => {
    const p = new URLSearchParams(params)
    if (k === 'overview') p.delete('tab'); else p.set('tab', k)
    setParams(p, { replace: true })
  }, [params, setParams])

  // Drawers are portalled to <body>, outside the full-screen element — leave full screen to show them.
  const showDrill = (bucket: string, title: string) => { fs.exit(); setDrill({ bucket, title }) }
  const open = (rec: OpenRecord) => {
    if (!access.canRead(rec.fqn)) return
    fs.exit()
    setOpenRec({ ...rec, back: drill ?? undefined })
    setDrill(null)
  }
  const closeRecord = () => { const back = openRec?.back; setOpenRec(null); if (back) setDrill(back) }

  if (!access.ready) return <Spinner />
  if (!access.dashboard) {
    return <Empty icon="ShieldOff" title="Asset dashboard not available">Your role does not include the asset dashboard. Ask an administrator if you need it.</Empty>
  }

  const props: TabProps | null = d ? { d, drill: showDrill, open, goTab, access } : null
  const k = d?.kpis
  const recEntity = openRec ? entities[openRec.fqn] : undefined

  return (
    <div ref={rootRef} className={cn('asset-dashboard space-y-3', fs.on && 'h-full overflow-y-auto bg-plane p-4 md:p-6')}>
      {/* print-only heading */}
      <div className="hidden print:block">
        <h1 className="text-lg font-semibold">Asset dashboard · {d?.branch ?? d?.hospital}</h1>
        {d && <p className="text-xs">{d.period.label} · {span(d.period.from, d.period.to)} · generated {date(d.generated_at)} {time(d.generated_at)}</p>}
      </div>

      <section className="rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] print:hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <Badge tone="cyan" className="uppercase tracking-wide"><Icon name="Wrench" className="size-3" /> Asset management</Badge>
          <h2 className="text-base font-semibold text-ink">{greeting()}{user?.name ? `, ${user.name}` : ''}</h2>
          {d && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
              <span className="inline-flex items-center gap-1"><Building2 className="size-3.5" />{d.branch ?? d.hospital}</span>
              <span className="inline-flex items-center gap-1"><CalendarDays className="size-3.5" />{span(d.period.from, d.period.to)}</span>
            </span>
          )}
          <div className="no-print ml-auto flex flex-wrap items-center gap-2">
            {embedded && <Link to="/assets/dashboard" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-brand-700 hover:bg-surface-2 dark:text-brand-300">
              <Maximize2 className="size-3.5" /> Open full screen</Link>}
          </div>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2 px-4 py-2.5">
          <Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className="h-8 w-auto min-w-36 text-xs">
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Select>
          {period === 'custom' && (
            <span className="flex items-center gap-1 text-xs text-ink-2">
              <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
              <span>to</span>
              <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-xs" />
            </span>
          )}
          <Select aria-label="Comparison" value={compare} onChange={(e) => setCompare(e.target.value as CompareKey)} className="h-8 w-auto min-w-40 text-xs">
            {COMPARES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
          {d?.compare && <span className="text-xs text-ink-3">vs {span(d.compare.from, d.compare.to)}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-3" aria-live="polite">{q.isFetching ? 'Updating…' : d ? `Updated ${time(d.generated_at)}` : ''}</span>
            <Button size="sm" variant="secondary" onClick={() => q.refetch()} disabled={!customOk} aria-label="Refresh now" title="Refresh now">
              <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} />
            </Button>
            <Select aria-label="Auto-refresh" value={auto} onChange={(e) => { const n = Number(e.target.value); setAuto(n); writeAuto(n) }} className="h-8 w-auto text-xs">
              {AUTO.map((n) => <option key={n} value={n}>{n ? `Auto-refresh ${n} min` : 'Auto-refresh off'}</option>)}
            </Select>
            {fs.supported && (
              <Button size="sm" variant="secondary" onClick={fs.toggle} aria-label={fs.on ? 'Exit full screen' : 'Full screen'} title={fs.on ? 'Exit full screen' : 'Full screen'}>
                {fs.on ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => window.print()} aria-label="Print" title="Print"><Printer className="size-4" /></Button>
          </div>
        </div>
        {period === 'custom' && !customOk && (
          <p className="no-print px-4 pb-2.5 text-xs text-amber-700 dark:text-amber-300">{from && to ? 'The start date is after the end date.' : 'Choose both dates to load the custom range.'}</p>
        )}
      </section>

      {q.error && (d ? <Badge tone="amber">Refresh failed — showing the last data. {q.error instanceof Error ? q.error.message : ''}</Badge> : <ErrorBox error={q.error} />)}
      {!d && q.isLoading && <Spinner label="Loading the asset register…" />}

      {d && k && props && (
        <>
          {k.total === 0 && (
            <Empty icon="PackagePlus" title="The asset register is empty"
              action={access.canRead('assets.assets') ? <Link to="/m/assets/assets" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Open the asset register →</Link> : undefined}>
              Register equipment to see status, due dates, maintenance and book value here.
            </Empty>
          )}
          <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-3', k.nbv !== null ? 'xl:grid-cols-6' : 'xl:grid-cols-5')}>
            <KpiTile icon="Boxes" label="Total assets" value={number(k.total)} caption="Every asset on the register" accent="brand" onDrill={() => showDrill('total', 'Total assets')} />
            <KpiTile icon="CircleCheck" label="Active" value={number(k.active)} caption={`${pctText(k.active_pct)} of the register`} accent="good" onDrill={() => showDrill('active', 'Active')} />
            <KpiTile icon="CircleSlash" label="Out of service" value={number(k.out_of_service)}
              caption={k.out_for_service ? `Status: out of service · ${k.out_for_service} more out for service` : 'Status: out of service'}
              accent={k.out_of_service ? 'critical' : 'neutral'} onDrill={() => showDrill('out_of_service', 'Out of service')} />
            <KpiTile icon="ClipboardList" label="Open work orders" value={number(k.open_work_orders)}
              caption={`Work still owed · ${k.open_breakdowns} breakdown${k.open_breakdowns === 1 ? '' : 's'}, ${k.pm_jobs_owed} PM`} accent="warning"
              onDrill={() => showDrill('open_work_orders', 'Open work orders')} />
            <KpiTile icon="AlarmClock" label="PM overdue" value={number(k.pm_overdue)} caption="Past due plus grace" accent={k.pm_overdue ? 'serious' : 'good'}
              onDrill={() => showDrill('pm_overdue', 'PM overdue')} />
            {k.nbv !== null && (
              <KpiTile icon="IndianRupee" label="Net book value" value={moneyShort(k.nbv)} caption={`Live SLM / WDV depreciation as at ${date(d.period.as_of)}`}
                accent="brand" onDrill={() => showDrill('nbv', 'Net book value')} />
            )}
          </div>

          <nav className={cn('no-print sticky z-10 -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface/95 p-1 backdrop-blur scroll-thin', fs.on ? 'top-0' : 'top-14')}
            role="tablist" aria-label="Dashboard sections">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => goTab(t.key)}
                className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  tab === t.key ? 'bg-brand-700 text-white shadow-sm' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
                <Icon name={t.icon} className="size-4" />
                {t.label}
                {!!t.alert && (
                  <span className={cn('min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold tabular',
                    tab === t.key ? 'bg-white text-red-700' : 'bg-red-600 text-white')} aria-label={`${t.alert} need attention`}>{t.alert}</span>
                )}
              </button>
            ))}
          </nav>

          <TabBody>
            {tab === 'overview' && <OverviewTab {...props} />}
            {tab === 'due' && <DueTab {...props} window={win} setWindow={setWin} />}
            {tab === 'maintenance' && <MaintenanceTab {...props} />}
            {tab === 'compliance' && <ComplianceTab {...props} />}
            {tab === 'register' && <RegisterTab {...props} />}
            {tab === 'finance' && <FinanceTab {...props} />}
          </TabBody>
        </>
      )}

      {drill && (
        <DrillDrawer bucket={drill.bucket} title={drill.title} params={dash} finance={!!d?.can_finance} canOpen={access.canRead('assets.assets')}
          onOpen={(id) => open({ fqn: 'assets.assets', id })} onClose={() => setDrill(null)} />
      )}
      {openRec && recEntity && <RecordDrawer entity={recEntity} id={openRec.id} onClose={closeRecord} />}
    </div>
  )
}

function TabBody({ children }: { children: ReactNode }) {
  return <div role="tabpanel" className="min-h-40">{children}</div>
}
