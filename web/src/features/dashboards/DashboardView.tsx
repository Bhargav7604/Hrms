/** One dashboard (built-in or designed): the shared header bar + a widget grid bound to metrics and reports. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Star } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge, Button, cn, Empty, ErrorBox, PageHeader, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { Icon } from '@/lib/icons'
import { useCatalogue, useFavouriteDashboard } from './Catalogue'
import { DashboardBar, TvFrame, useAutoRefresh, useDashParams, useTvMode } from './controls'
import type { WidgetSpec } from './types'
import { useWidgets, WidgetGrid } from './WidgetGrid'

interface Board {
  key: string; name: string; description: string; icon: string; kind: 'builtin' | 'custom'; new?: boolean; widgets: WidgetSpec[]
  default_preset: string; favourite?: boolean; can_edit: boolean; owner?: string; status?: string
}

function MyDashboards() {
  const q = useCatalogue()
  const fav = useFavouriteDashboard()
  const d = q.data
  return (
    <div>
      <PageHeader icon="LayoutGrid" title="My dashboards" subtitle="Dashboards built in the designer — yours and the ones shared with you."
        actions={<><Link to="/dashboards"><Button size="sm"><ArrowLeft className="size-4" /> All dashboards</Button></Link>
          {d?.groups.some((g) => g.key === 'custom') && <Link to="/dashboards/designer"><Button size="sm" variant="primary" icon="Plus">New dashboard</Button></Link>}</>} />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {d && !d.custom.length && <Empty icon="LayoutGrid" title="No designed dashboards yet">Build one from KPI tiles, charts and report tables, then share it with roles or colleagues.</Empty>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {d?.custom.map((x) => (
          <div key={x.key} className="relative rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-brand-600/40">
            <div className="flex items-start gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-surface-2 text-brand-700 dark:text-brand-300"><Icon name={x.icon} className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <Link to={`/dashboards/${x.key}`} className="text-sm font-semibold text-ink after:absolute after:inset-0">{x.name}</Link>
                <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{x.description || 'No description'}</p>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                  <Badge tone={x.status === 'Published' ? 'green' : 'amber'}>{x.status === 'Published' ? 'Shared' : 'Draft'}</Badge>
                  {x.mine ? 'Yours' : `By ${x.owner}`}{x.visible_to_roles?.length ? ` · ${x.visible_to_roles.join(', ')}` : ''}
                </p>
              </div>
              <button type="button" onClick={() => fav.mutate(x.key)} className="relative z-10 rounded-md p-1 text-ink-3 hover:text-amber-500"
                aria-label={d.favourites.includes(x.key) ? 'Remove from favourites' : 'Add to favourites'}>
                <Star className={cn('size-4', d.favourites.includes(x.key) && 'fill-amber-400 text-amber-500')} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Board({ id }: { id: string }) {
  const qc = useQueryClient()
  const b = useQuery({ queryKey: ['dash', 'board', id], queryFn: () => api<Board>(`/dashboards/${id}`), staleTime: 60_000 })
  const { params, set } = useDashParams(b.data?.default_preset ?? 'this_month')
  const auto = useAutoRefresh(`dash:auto:${id}`)
  const frame = useRef<HTMLDivElement>(null)
  const tv = useTvMode(frame)
  const [nonce, setNonce] = useState(0)
  const w = useWidgets(id, b.data?.widgets ?? [], params, auto.interval, nonce)
  const fav = useFavouriteDashboard()
  if (b.isLoading) return <Spinner />
  if (b.error) return <ErrorBox error={b.error} />
  const d = b.data!
  return (
    <TvFrame tv={tv.tv} frameRef={frame}>
      <div className="space-y-3">
        <DashboardBar chip="Dashboard" title={<span className="inline-flex items-center gap-2"><Icon name={d.icon} className="size-4 text-brand-700 dark:text-brand-300" />{d.name}
          {d.new && <Badge tone="green">New</Badge>}</span>}
          params={params} onChange={set} range={w.data?.range} compare={w.data?.compare} updatedAt={w.dataUpdatedAt} fetching={w.isFetching}
          onRefresh={() => { setNonce((n) => n + 1); qc.invalidateQueries({ queryKey: ['dash', 'board', id] }) }} auto={auto.secs} onAuto={auto.setSecs} tv={tv.tv} onTv={tv.toggle}
          extra={<>
            <Link to="/dashboards" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-ink-2 hover:bg-surface-2"><ArrowLeft className="size-4" /> All</Link>
            <button type="button" onClick={() => fav.mutate(id)} aria-pressed={!!d.favourite} aria-label={d.favourite ? 'Remove from favourites' : 'Add to favourites'}
              className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2"><Star className={cn('size-4', d.favourite && 'fill-amber-400 text-amber-500')} /></button>
            {d.can_edit && <Link to={`/dashboards/designer/${d.key.slice(2)}`}><Button size="sm"><Pencil className="size-4" /> Edit</Button></Link>}
          </>} />
        {d.description && <p className="px-1 text-sm text-ink-2">{d.description}</p>}
        {w.error && <ErrorBox error={w.error} />}
        {!d.widgets.length ? <Empty icon="LayoutGrid" title="This dashboard has no widgets for your role" />
          : <WidgetGrid widgets={d.widgets} data={w.data?.widgets} compare={w.data?.compare} />}
      </div>
    </TvFrame>
  )
}

export default function DashboardView() {
  const { key = '' } = useParams()
  if (key === 'mine') return <MyDashboards />
  return <Board key={key} id={key} />
}
