import { useQuery } from '@tanstack/react-query'
import { CornerDownLeft, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Avatar, cn, Kbd, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useAuth, useBranch, useRegistry } from '@/lib/auth'
import { openLauncher, openShortcutHelp, setChrome, toggleFocus, useChrome } from '@/lib/chrome'
import { age } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { matchPage, usePages } from '@/lib/pages'
import { usePref } from '@/lib/prefs'
import type { Rec } from '@/lib/types'
import { SUITE_TONE } from './AppLauncher'

interface Item {
  id: string
  section: 'Patients' | 'Pages' | 'Actions' | 'Create' | 'Recent'
  label: string
  hint?: string
  icon: string
  tone?: string
  avatar?: string
  run: () => void
  score: number
}

const RECENT_KEY = 'vlack.recent'

export function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] }
}
export function pushRecent(path: string) {
  try {
    const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* storage unavailable */ }
}

/** ⌘K / Ctrl+K: jump to any page, module, workspace or patient, or run an action. */
export function CommandPalette({ onToggleTheme }: { onToggleTheme: () => void }) {
  const { palette } = useChrome()
  if (!palette) return null
  return <Palette onClose={() => setChrome({ palette: false })} onToggleTheme={onToggleTheme} />
}

function Palette({ onClose, onToggleTheme }: { onClose: () => void; onToggleTheme: () => void }) {
  const nav = useNavigate()
  const reg = useRegistry()
  const { logout } = useAuth()
  const { branches, branch, switchBranch } = useBranch()
  const pages = usePages()
  const [favs] = usePref<string[]>('launcher.favourites', [])
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const dq = useDebounced(q, 200)
  const listRef = useRef<HTMLDivElement>(null)
  const canPatients = reg.canEntity('registration.patients')
  const patients = useQuery({
    queryKey: ['psearch', dq],
    queryFn: () => api<Rec[]>('/lookup/registration/patients', { query: { q: dq, limit: 6 } }),
    enabled: canPatients && dq.trim().length >= 2,
    staleTime: 30_000,
  })

  const go = (path: string) => { onClose(); nav(path) }
  const items: Item[] = useMemo(() => {
    const out: Item[] = []
    const query = q.trim()
    if (query.length >= 2) {
      for (const p of patients.data ?? []) {
        out.push({ id: `pt:${p.id}`, section: 'Patients', label: p.title ?? p.code ?? 'Patient', avatar: p.title,
          hint: [p.code, [age(p.dob), p.gender?.[0]].filter(Boolean).join('/'), p.phone ? `•••${String(p.phone).slice(-4)}` : null].filter(Boolean).join(' · '),
          icon: 'UserRound', run: () => go(`/patients/${p.id}`), score: 10 })
      }
    }
    const scored = pages.map((p) => ({ p, s: matchPage(p, query) })).filter((x) => x.s > 0)
    if (!query) {
      const byPath = new Map(pages.map((p) => [p.path, p]))
      for (const path of readRecent()) {
        const p = byPath.get(path)
        if (p) out.push({ id: `recent:${p.id}`, section: 'Recent', label: p.label, hint: p.group, icon: p.icon, tone: SUITE_TONE[p.suite], run: () => go(p.path), score: 5 })
      }
      for (const p of pages.filter((x) => favs.includes(x.id))) {
        out.push({ id: `pg:${p.id}`, section: 'Pages', label: p.label, hint: `★ ${p.group}`, icon: p.icon, tone: SUITE_TONE[p.suite], run: () => go(p.path), score: 4 })
      }
    } else {
      for (const { p, s } of scored.sort((a, b) => b.s - a.s).slice(0, 12)) {
        out.push({ id: `pg:${p.id}`, section: 'Pages', label: p.label, hint: `${p.group}${p.kind === 'records' ? ' · records' : ''}${p.level === 'view' ? ' · view only' : ''}`,
          icon: p.icon, tone: SUITE_TONE[p.suite], run: () => go(p.path), score: s })
      }
    }
    const actions: Omit<Item, 'section' | 'score'>[] = []
    if (reg.canPage('registration', 'patient-registration', 'edit')) actions.push({ id: 'a:register', label: 'Register a new patient', icon: 'UserPlus', run: () => go('/m/registration/patient-registration') })
    actions.push(
      { id: 'a:compose', label: 'New message', hint: 'Internal message or task', icon: 'Send', run: () => go('/messages?compose=1') },
      { id: 'a:ticket', label: 'Raise a support ticket', icon: 'LifeBuoy', run: () => go('/support?tab=ticket') },
      { id: 'a:launcher', label: 'Open App Launcher', hint: 'Ctrl+G', icon: 'LayoutGrid', run: () => { onClose(); openLauncher() } },
      { id: 'a:focus', label: 'Toggle focus mode', hint: 'Shift+F', icon: 'Maximize2', run: () => { onClose(); toggleFocus() } },
      { id: 'a:theme', label: 'Toggle dark mode', icon: 'Moon', run: () => { onClose(); onToggleTheme() } },
      { id: 'a:keys', label: 'Keyboard shortcuts', hint: '?', icon: 'Keyboard', run: () => { onClose(); openShortcutHelp() } },
      { id: 'a:sessions', label: 'Devices & sessions', icon: 'MonitorSmartphone', run: () => go('/account/sessions') },
    )
    for (const b of branches) {
      if (b.code === branch) continue
      actions.push({ id: `a:branch:${b.code}`, label: `Switch branch to ${b.name}`, hint: b.code, icon: 'Building2',
        run: () => { onClose(); switchBranch(b.code); toast.success(`Switched to ${b.name}`) } })
    }
    actions.push({ id: 'a:logout', label: 'Sign out', icon: 'LogOut', run: () => { onClose(); logout().then(() => nav('/login')) } })
    const ql = query.toLowerCase()
    for (const a of actions) {
      if (!ql || `${a.label} ${a.hint ?? ''}`.toLowerCase().includes(ql)) out.push({ ...a, section: 'Actions', score: 1 })
    }
    if (ql.length >= 2) {
      const creatable = reg.modules.flatMap((m) => m.entities.filter((e) => m.access.entities[e.key]?.write && !e.readonly)
        .map((e) => ({ m, e }))).filter(({ m, e }) => `new ${e.singular} ${e.label} ${m.name}`.toLowerCase().includes(ql.replace(/^(new|create|add)\s+/, '')))
      for (const { m, e } of creatable.slice(0, 5)) {
        out.push({ id: `c:${e.fqn}`, section: 'Create', label: `New ${e.singular.toLowerCase()}`, hint: m.name, icon: e.icon ?? m.icon,
          run: () => go(`/m/${m.id}/${e.key}?new=1`), score: 0 })
      }
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pages, patients.data, favs, branches, branch, reg])

  useEffect(() => { setActive(0) }, [q])
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) setQ(''); else onClose() }
  }

  let last = ''
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 p-3 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label="Command palette" className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" onKeyDown={onKey}>
        <div className="relative border-b border-line">
          <Search className="pointer-events-none absolute left-4 top-3.5 size-5 text-ink-3" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded aria-controls="cmdk-list"
            placeholder={canPatients ? 'Search pages, modules, patients (UHID, mobile, name) or actions…' : 'Search pages, modules or actions…'}
            className="h-12 w-full bg-transparent pl-12 pr-4 text-[15px] text-ink outline-none placeholder:text-ink-3" />
        </div>
        <div ref={listRef} id="cmdk-list" role="listbox" className="max-h-[60vh] overflow-y-auto py-1 scroll-thin">
          {patients.isFetching && q.trim().length >= 2 && !patients.data && <Spinner className="py-3" label="Searching patients…" />}
          {items.length === 0 && <div className="px-4 py-8 text-center text-sm text-ink-3">Nothing matches “{q}”.</div>}
          {items.map((it, i) => {
            const header = it.section !== last ? it.section : null
            last = it.section
            return (
              <div key={it.id}>
                {header && <div className="px-4 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{header}</div>}
                <button role="option" aria-selected={active === i} data-active={active === i} onMouseMove={() => setActive(i)} onClick={() => it.run()}
                  className={cn('flex w-full items-center gap-3 px-4 py-2 text-left', active === i ? 'bg-brand-50 dark:bg-brand-500/10' : '')}>
                  {it.avatar ? <Avatar name={it.avatar} size="sm" /> : (
                    <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', it.tone ? `${it.tone} text-white` : 'bg-surface-2 text-ink-2 ring-1 ring-line')}>
                      <Icon name={it.icon} className="size-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{it.label}</span>
                    {it.hint && <span className="block truncate text-xs text-ink-3">{it.hint}</span>}
                  </span>
                  {active === i && <CornerDownLeft className="size-4 text-ink-3" />}
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-3">
          <span><Kbd>↑↓</Kbd> navigate</span><span><Kbd>↵</Kbd> open</span><span><Kbd>Esc</Kbd> close</span>
          <span className="ml-auto"><Kbd>Ctrl+G</Kbd> all pages</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
