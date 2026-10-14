/**
 * Reports Hub — every report the role may open (curated MIS reports + a register for every record type):
 * search ("/" to focus), category chips with counts, cards or list, favourites, recently used and Popular tags.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Clock, Flame, Info, LayoutGrid, List, Search, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Badge, cn, Empty, ErrorBox, Input, Kbd, PageHeader, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { Icon } from '@/lib/icons'
import { usePref } from '@/lib/prefs'
import type { HubCatalog, ReportCard } from './types'

const FILTER_LABEL: Record<string, string> = {
  period: 'Date range', q: 'Search', doctor: 'Doctor', department: 'Department', payer: 'Payer / sponsor', status: 'Status', view: 'View',
  ward: 'Ward', patient: 'Patient', store: 'Store', mode: 'Payment mode', type: 'Type', category: 'Category', kind: 'Type', priority: 'Priority',
}
export const filterLabel = (k: string) => FILTER_LABEL[k] ?? (k.startsWith('f_') ? k.slice(2).replace(/_/g, ' ') : k.replace(/_/g, ' '))
const PER_SECTION = 12

export function useHubCatalog() {
  return useQuery({ queryKey: ['reports', 'catalog'], queryFn: () => api<HubCatalog>('/reports/catalog'), staleTime: 60_000 })
}

export function useFavouriteReport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => api<{ favourite: boolean }>(`/reports/${code}/favourite`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(r.favourite ? 'Added to favourites' : 'Removed from favourites'); qc.invalidateQueries({ queryKey: ['reports'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

function RCard({ r, fav, popular, onFav }: { r: ReportCard; fav: boolean; popular: boolean; onFav: () => void }) {
  return (
    <div className="group relative flex flex-col rounded-xl border border-line bg-surface p-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition hover:-translate-y-0.5 hover:border-brand-600/40 hover:shadow-md">
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-md bg-brand-950 text-white dark:bg-brand-700"><Icon name={r.icon} className="size-3.5" /></span>
        <span className="font-mono text-[11px] text-ink-3">{r.code}</span>
        {popular && <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-orange-700 dark:text-orange-300"><Flame className="size-3" />Popular</span>}
        <span className="ml-auto flex items-center gap-0.5">
          <span title={r.description} className="relative z-10 rounded p-0.5 text-ink-3"><Info className="size-3.5" /><span className="sr-only">{r.description}</span></span>
          <button type="button" onClick={onFav} aria-pressed={fav} aria-label={fav ? `Remove ${r.name} from favourites` : `Add ${r.name} to favourites`}
            className="relative z-10 rounded p-0.5 text-ink-3 hover:text-amber-500"><Star className={cn('size-3.5', fav && 'fill-amber-400 text-amber-500')} /></button>
        </span>
      </div>
      <Link to={`/reports/${r.code}`} className="mt-2 text-sm font-semibold text-ink after:absolute after:inset-0 focus-visible:outline-none">{r.name}</Link>
      <p className="mt-1 line-clamp-3 text-xs text-ink-2">{r.description}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-2.5">
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-ink-3">Filters: {r.filters.map(filterLabel).join(' · ') || 'none'}</span>
        <ArrowRight className="size-3.5 shrink-0 text-ink-3 group-hover:text-ink" />
      </div>
    </div>
  )
}

export default function ReportsHub() {
  const q = useHubCatalog()
  const fav = useFavouriteReport()
  const [sp, setSp] = useSearchParams()
  const [mode, setMode] = usePref<'cards' | 'list'>('reports:hub-view', 'cards')
  const [search, setSearch] = useState(sp.get('q') ?? '')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const cat = sp.get('cat') ?? 'All'
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) { e.preventDefault(); box.current?.focus() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  const d = q.data
  const setCat = (c: string) => setSp((p) => { const n = new URLSearchParams(p); if (c === 'All') n.delete('cat'); else n.set('cat', c); return n }, { replace: true })
  const s = search.trim().toLowerCase()
  const byCode = useMemo(() => new Map((d?.reports ?? []).map((r) => [r.code, r])), [d])
  const filtered = useMemo(() => (d?.reports ?? []).filter((r) => {
    if (cat === '★ Favourites' && !d!.favourites.includes(r.code)) return false
    if (cat === 'Popular' && !d!.popular.includes(r.code)) return false
    if (!['All', '★ Favourites', 'Popular'].includes(cat) && r.category !== cat) return false
    return !s || `${r.code} ${r.name} ${r.description} ${r.category} ${r.tags.join(' ')}`.toLowerCase().includes(s)
  }), [d, cat, s])
  const sections = useMemo(() => {
    const m = new Map<string, ReportCard[]>()
    for (const r of filtered) m.set(r.category, [...(m.get(r.category) ?? []), r])
    return (d?.categories ?? []).filter((c) => m.has(c.name)).map((c) => ({ ...c, items: m.get(c.name)! }))
  }, [filtered, d])
  const popular = new Set(d?.popular ?? [])

  return (
    <div>
      <PageHeader icon="FileBarChart" title="Reports Hub"
        subtitle={d ? `${d.total} reports available to you — billing, collections, revenue, doctors, insurance, clinical, statutory, NABH, GST, supply chain, HR and a register for every record type. Open one to filter, chart, save a view, export or schedule it.` : 'Loading…'}
        actions={
          <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5" role="group" aria-label="Layout">
            <button type="button" onClick={() => setMode('cards')} aria-pressed={mode === 'cards'} className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium', mode === 'cards' ? 'bg-brand-900 text-white' : 'text-ink-2')}><LayoutGrid className="size-3.5" />Cards</button>
            <button type="button" onClick={() => setMode('list')} aria-pressed={mode === 'list'} className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium', mode === 'list' ? 'bg-brand-900 text-white' : 'text-ink-2')}><List className="size-3.5" />List</button>
          </div>
        } />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {d && !d.total && <Empty icon="FileBarChart" title="No reports for your role">Your role cannot open any report. Ask an administrator if you need one.</Empty>}
      {d && d.total > 0 && (
        <div className="space-y-4">
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-3" />
            <Input ref={box} value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search reports — try "collection", "doctor", "GST", "discharge", "TDS"' className="pl-9 pr-10" aria-label="Search reports" />
            <span className="pointer-events-none absolute right-2.5 top-2"><Kbd>/</Kbd></span>
          </div>
          <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Categories">
            {[{ name: 'All', count: d.total }, ...(d.favourites.length ? [{ name: '★ Favourites', count: d.favourites.length }] : []), { name: 'Popular', count: d.popular.length }, ...d.categories].map((c) => (
              <button key={c.name} type="button" onClick={() => setCat(c.name)} aria-pressed={cat === c.name}
                className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', cat === c.name ? 'border-brand-900 bg-brand-900 text-white dark:border-brand-600 dark:bg-brand-600' : 'border-line bg-surface text-ink-2 hover:bg-surface-2')}>
                {c.name} <span className={cn('ml-0.5', cat === c.name ? 'text-white/80' : 'text-ink-3')}>{c.count}</span>
              </button>
            ))}
          </div>
          {d.recent.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink"><Clock className="size-3.5" /> Recently used</p>
              <div className="flex flex-wrap gap-1.5">
                {d.recent.slice(0, 8).map((c) => byCode.get(c)).filter(Boolean).map((r) => (
                  <Link key={r!.code} to={`/reports/${r!.code}`} className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink hover:bg-surface-2">{r!.name}</Link>
                ))}
              </div>
            </div>
          )}
          {!filtered.length && <Empty icon="SearchX" title="No report matches">Try another word or clear the category.</Empty>}
          {mode === 'list' && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-2 text-left font-medium">Code</th><th className="px-3 py-2 text-left font-medium">Report</th>
                  <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Category</th><th className="hidden px-3 py-2 text-left font-medium lg:table-cell">Filters</th><th className="w-10" /></tr></thead>
                <tbody>
                  {filtered.slice(0, 400).map((r) => (
                    <tr key={r.code} className="border-t border-line hover:bg-surface-2">
                      <td className="px-3 py-1.5 font-mono text-xs text-ink-3">{r.code}</td>
                      <td className="px-3 py-1.5"><Link to={`/reports/${r.code}`} className="font-medium text-ink hover:underline">{r.name}</Link>
                        {popular.has(r.code) && <Badge tone="amber" className="ml-2">Popular</Badge>}<p className="line-clamp-1 text-xs text-ink-3">{r.description}</p></td>
                      <td className="hidden px-3 py-1.5 text-xs text-ink-2 md:table-cell">{r.category}</td>
                      <td className="hidden px-3 py-1.5 text-[11px] uppercase text-ink-3 lg:table-cell">{r.filters.map(filterLabel).join(' · ')}</td>
                      <td className="px-2"><button type="button" onClick={() => fav.mutate(r.code)} aria-label="Favourite" className="p-1 text-ink-3 hover:text-amber-500">
                        <Star className={cn('size-4', d.favourites.includes(r.code) && 'fill-amber-400 text-amber-500')} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {mode === 'cards' && sections.map((sec) => {
            const open = expanded[sec.name] || cat !== 'All' || !!s
            const items = open ? sec.items : sec.items.slice(0, PER_SECTION)
            return (
              <section key={sec.name}>
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <span className="rounded-full bg-brand-950 px-2.5 py-0.5 text-xs font-semibold text-white dark:bg-brand-700">{sec.name}</span>
                  <span className="text-xs text-ink-2">{sec.items.length} reports</span>
                  <span className="text-xs text-ink-3">· {sec.description}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {items.map((r) => <RCard key={r.code} r={r} fav={d.favourites.includes(r.code)} popular={popular.has(r.code)} onFav={() => fav.mutate(r.code)} />)}
                </div>
                {sec.items.length > items.length && (
                  <button type="button" onClick={() => setExpanded({ ...expanded, [sec.name]: true })} className="mt-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
                    Show all {sec.items.length} {sec.name.toLowerCase()}
                  </button>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
