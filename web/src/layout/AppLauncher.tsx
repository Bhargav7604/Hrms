import { Eye, LayoutGrid, Search, Star, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { cn, Kbd } from '@/components/ui'
import { useRegistry } from '@/lib/auth'
import { setChrome, useChrome } from '@/lib/chrome'
import { Icon } from '@/lib/icons'
import { ADMIN_SUITE, matchPage, PLATFORM_SUITE, usePages, type PageItem } from '@/lib/pages'
import { usePref } from '@/lib/prefs'

/** Tile colour per suite (icon square). Text labels always accompany the colour. */
export const SUITE_TONE: Record<string, string> = {
  'front-office': 'bg-sky-600', clinical: 'bg-emerald-600', operations: 'bg-amber-600', governance: 'bg-indigo-600',
  specialty: 'bg-rose-600', hr: 'bg-cyan-700', platform: 'bg-brand-700', admin: 'bg-slate-700',
}
const SUITE_RULE: Record<string, string> = {
  'front-office': 'border-sky-600', clinical: 'border-emerald-600', operations: 'border-amber-600', governance: 'border-indigo-600',
  specialty: 'border-rose-600', hr: 'border-cyan-700', platform: 'border-brand-700', admin: 'border-slate-700',
}

interface Section { id: string; label: string; suite: string; items: PageItem[] }

/** App Launcher (Ctrl+G): every page the role can open, grouped by module, with live search and favourites. */
export function AppLauncher() {
  const { launcher } = useChrome()
  if (!launcher) return null
  return <LauncherDialog onClose={() => setChrome({ launcher: false })} />
}

function LauncherDialog({ onClose }: { onClose: () => void }) {
  const reg = useRegistry()
  const pages = usePages()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [chip, setChip] = useState<string>('all')
  const [active, setActive] = useState(0)
  const [favs, setFavs] = usePref<string[]>('launcher.favourites', [])
  const input = useRef<HTMLInputElement>(null)
  const tiles = useRef<(HTMLButtonElement | null)[]>([])
  const fav = useMemo(() => new Set(favs), [favs])

  const suites = useMemo(() => [...(reg.meta?.suites ?? []), PLATFORM_SUITE, ADMIN_SUITE], [reg.meta])
  const matched = useMemo(() => pages.filter((p) => matchPage(p, q) > 0), [pages, q])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const p of matched) c[p.suite] = (c[p.suite] ?? 0) + 1
    return c
  }, [matched])
  const sections: Section[] = useMemo(() => {
    const shown = chip === 'all' ? matched : chip === 'fav' ? matched.filter((p) => fav.has(p.id)) : matched.filter((p) => p.suite === chip)
    const out: Section[] = []
    if (chip === 'all' && !q && fav.size) {
      const favItems = pages.filter((p) => fav.has(p.id))
      if (favItems.length) out.push({ id: '__fav', label: 'Favourites', suite: 'platform', items: favItems })
    }
    const by = new Map<string, Section>()
    const order = suites.map((s) => s.id)
    for (const p of [...shown].sort((a, b) => order.indexOf(a.suite) - order.indexOf(b.suite))) {
      let s = by.get(p.groupId)
      if (!s) { s = { id: p.groupId, label: p.group, suite: p.suite, items: [] }; by.set(p.groupId, s); out.push(s) }
      s.items.push(p)
    }
    return out
  }, [matched, chip, fav, pages, q, suites])
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections])

  useEffect(() => { setActive(0) }, [q, chip])
  useEffect(() => { tiles.current[active]?.scrollIntoView({ block: 'nearest' }) }, [active])

  const go = (p?: PageItem) => {
    if (!p) return
    onClose()
    nav(p.path)
  }
  const toggleFav = (id: string) => setFavs(fav.has(id) ? favs.filter((x) => x !== id) : [...favs, id])

  /** ↑/↓ move to the nearest tile in the row above/below (grid geometry), ←/→ to the previous/next tile. */
  const moveVertical = (dir: 1 | -1) => {
    const cur = tiles.current[active]?.getBoundingClientRect()
    if (!cur) return setActive(0)
    let best = -1
    let bestScore = Infinity
    tiles.current.forEach((el, i) => {
      if (!el || i === active) return
      const r = el.getBoundingClientRect()
      const dy = (r.top - cur.top) * dir
      if (dy <= 4) return
      const score = dy * 10 + Math.abs(r.left - cur.left)
      if (score < bestScore) { bestScore = score; best = i }
    })
    if (best >= 0) setActive(best)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (q) setQ('')
      else onClose()
    } else if (e.key === 'ArrowRight') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveVertical(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveVertical(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]) }
    else if (e.key === '/' && document.activeElement !== input.current) { e.preventDefault(); input.current?.focus() }
  }

  let idx = -1
  tiles.current = []
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/50 p-3 pt-[5vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKey}>
      <div role="dialog" aria-modal aria-label="App Launcher" className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="bg-gradient-to-r from-brand-950 to-brand-800 px-5 pb-4 pt-3 text-white">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-white/15"><LayoutGrid className="size-5" /></div>
            <div className="leading-tight">
              <div className="text-base font-semibold">App Launcher</div>
              <div className="text-xs text-cyan-100/80">{pages.length} pages accessible</div>
            </div>
            <button className="ml-auto rounded-md p-1.5 text-white/80 hover:bg-white/15 hover:text-white" onClick={onClose} aria-label="Close"><X className="size-5" /></button>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-white/70" />
            <input ref={input} autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search pages, modules… (↑↓←→ navigate ↵ open)"
              className="h-10 w-full rounded-lg bg-white/15 pl-9 pr-3 text-sm text-white placeholder:text-white/60 outline-none focus:bg-white/20" />
          </div>
        </div>
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2 scroll-thin" role="tablist">
          <Chip active={chip === 'all'} onClick={() => setChip('all')} label="All" count={matched.length} />
          <Chip active={chip === 'fav'} onClick={() => setChip('fav')} label="★ Favourites" count={matched.filter((p) => fav.has(p.id)).length} />
          {suites.map((s) => counts[s.id] ? <Chip key={s.id} active={chip === s.id} onClick={() => setChip(s.id)} label={s.short} count={counts[s.id]} /> : null)}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 scroll-thin">
          {sections.length === 0 && (
            <div className="py-16 text-center text-sm text-ink-3">
              {chip === 'fav' ? 'No favourites yet — hover a tile and click ★ to pin it here.' : `No pages match “${q}”.`}
            </div>
          )}
          {sections.map((s) => (
            <section key={s.id} className="mb-5">
              <h3 className={cn('mb-2 flex items-center gap-2 border-l-[3px] pl-2 text-[11px] font-bold uppercase tracking-wider text-ink-2', SUITE_RULE[s.suite] ?? 'border-brand-700')}>
                {s.label} <span className="font-medium text-ink-3">{s.items.length}</span>
              </h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-1">
                {s.items.map((p) => {
                  idx += 1
                  const i = idx
                  return (
                    <div key={`${s.id}-${p.id}`} className="group relative">
                      <button ref={(el) => { tiles.current[i] = el }} onClick={() => go(p)} onMouseEnter={() => setActive(i)}
                        className={cn('flex w-full flex-col items-center gap-1.5 rounded-xl px-1.5 py-2.5 text-center outline-none',
                          active === i ? 'bg-brand-50 ring-2 ring-brand-600/40 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
                        <span className={cn('grid size-11 place-items-center rounded-xl text-white shadow-sm', SUITE_TONE[p.suite] ?? 'bg-brand-700',
                          p.kind === 'records' && 'opacity-85')}>
                          <Icon name={p.icon} className="size-5" />
                        </span>
                        <span className="line-clamp-2 text-[11.5px] font-medium leading-tight text-ink">{p.label}</span>
                        {p.level === 'view' && <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-3"><Eye className="size-3" /> view</span>}
                      </button>
                      <button type="button" onClick={() => toggleFav(p.id)} aria-label={fav.has(p.id) ? `Remove ${p.label} from favourites` : `Add ${p.label} to favourites`}
                        className={cn('absolute right-1 top-1 rounded p-0.5', fav.has(p.id) ? 'text-amber-500' : 'text-ink-3 opacity-0 hover:text-amber-500 group-hover:opacity-100')}>
                        <Star className={cn('size-3.5', fav.has(p.id) && 'fill-amber-400')} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-2 px-5 py-2 text-[11px] text-ink-3">
          <span><Kbd>Esc</Kbd> {q ? 'clear search' : 'close'}</span>
          <span><Kbd>↑↓←→</Kbd> navigate</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>/</Kbd> focus search</span>
          <span><Star className="inline size-3 text-amber-500" /> favourite</span>
          <span className="ml-auto"><Kbd>Ctrl+G</Kbd> toggle</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button role="tab" aria-selected={active} onClick={onClick}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
        active ? 'bg-brand-800 text-white ring-brand-800' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
      {label} <span className={cn('tabular rounded-full px-1', active ? 'bg-white/20' : 'bg-surface-2')}>{count}</span>
    </button>
  )
}
