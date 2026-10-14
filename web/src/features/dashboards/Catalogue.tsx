/** Dashboards catalogue — every dashboard this role may open, grouped by area, with favourites and NEW badges. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Search, Star } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, cn, Empty, ErrorBox, Input, PageHeader, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { Icon } from '@/lib/icons'
import type { Catalogue, DashboardCard } from './types'

export function useCatalogue() {
  return useQuery({ queryKey: ['dash', 'catalogue'], queryFn: () => api<Catalogue>('/dashboards'), staleTime: 60_000 })
}

export function useFavouriteDashboard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (key: string) => api<{ favourite: boolean }>(`/dashboards/${key}/favourite`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(r.favourite ? 'Added to favourites' : 'Removed from favourites'); qc.invalidateQueries({ queryKey: ['dash', 'catalogue'] }); qc.invalidateQueries({ queryKey: ['dash', 'board'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

function Card({ d, fav, onFav }: { d: DashboardCard; fav: boolean; onFav?: () => void }) {
  const to = d.key === 'designer' ? '/dashboards/designer' : `/dashboards/${d.key}`
  return (
    <div className="group relative flex flex-col rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition hover:-translate-y-0.5 hover:border-brand-600/40 hover:shadow-md">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-brand-700 dark:text-brand-300"><Icon name={d.icon} className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
            <Link to={to} className="after:absolute after:inset-0 focus-visible:outline-none">{d.name}</Link>
            {d.new && <Badge tone="green">✦ New</Badge>}
            {d.kind === 'custom' && d.status === 'Draft' && <Badge tone="amber">Draft</Badge>}
          </h3>
          <p className="mt-1 line-clamp-2 text-xs text-ink-2">{d.description}</p>
          {d.kind === 'custom' && <p className="mt-1 text-[11px] text-ink-3">{d.mine ? 'Yours' : `Shared by ${d.owner ?? '—'}`}{d.visible_to_roles?.length ? ` · roles: ${d.visible_to_roles.join(', ')}` : ''}</p>}
        </div>
        {onFav && (
          <button type="button" onClick={onFav} aria-pressed={fav} aria-label={fav ? `Remove ${d.name} from favourites` : `Add ${d.name} to favourites`}
            className="relative z-10 rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-amber-500">
            <Star className={cn('size-4', fav && 'fill-amber-400 text-amber-500')} />
          </button>
        )}
      </div>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-300">Open <ArrowRight className="size-3" /></span>
    </div>
  )
}

export default function DashboardsCatalogue() {
  const q = useCatalogue()
  const fav = useFavouriteDashboard()
  const [search, setSearch] = useState('')
  const d = q.data
  const s = search.trim().toLowerCase()
  const match = (x: DashboardCard) => !s || `${x.name} ${x.description}`.toLowerCase().includes(s)
  const favs = useMemo(() => {
    if (!d) return []
    const all = [...d.groups.flatMap((g) => g.dashboards), ...d.custom]
    return d.favourites.map((k) => all.find((x) => x.key === k)).filter(Boolean) as DashboardCard[]
  }, [d])

  return (
    <div>
      <PageHeader icon="LayoutDashboard" title="Dashboards" subtitle={d ? `${d.total} dashboards open to you — grouped by area. Star the ones you use most.` : 'Loading…'}
        actions={d?.groups.some((g) => g.key === 'custom') ? <Link to="/dashboards/designer"><Button variant="primary" size="sm" icon="PencilRuler">Design a dashboard</Button></Link> : null} />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {d && !d.groups.length && <Empty icon="LayoutDashboard" title="No dashboards for your role">Your role cannot open any dashboard. Ask an administrator if you need one.</Empty>}
      {d && d.groups.length > 0 && (
        <div className="space-y-6">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-3" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a dashboard…" className="pl-9" aria-label="Find a dashboard" />
          </div>
          {favs.filter(match).length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Star className="size-4 fill-amber-400 text-amber-500" /> Favourites <span className="text-xs font-normal text-ink-3">({favs.length})</span></h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{favs.filter(match).map((x) => <Card key={x.key} d={x} fav onFav={() => fav.mutate(x.key)} />)}</div>
            </section>
          )}
          {d.groups.map((g) => {
            const items = g.dashboards.filter(match)
            if (!items.length) return null
            return (
              <section key={g.key}>
                <h2 className="mb-2 flex flex-wrap items-baseline gap-2 text-sm font-semibold text-ink">
                  <Icon name={g.icon} className="size-4 self-center text-ink-3" /> {g.name} <span className="text-xs font-normal text-ink-3">({items.length})</span>
                  <span className="text-xs font-normal text-ink-3">{g.description}</span>
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {items.map((x) => <Card key={x.key} d={x} fav={d.favourites.includes(x.key)} onFav={x.kind === 'link' ? undefined : () => fav.mutate(x.key)} />)}
                </div>
              </section>
            )
          })}
          {d.custom.filter(match).length > 0 && (
            <section>
              <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-ink"><Icon name="LayoutGrid" className="size-4 self-center text-ink-3" /> Your dashboards
                <span className="text-xs font-normal text-ink-3">Built in the designer — yours and the ones shared with you</span></h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {d.custom.filter(match).map((x) => <Card key={x.key} d={x} fav={d.favourites.includes(x.key)} onFav={() => fav.mutate(x.key)} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
