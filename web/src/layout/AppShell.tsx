import { useQuery } from '@tanstack/react-query'
import { Bell, Building2, Check, ChevronDown, LayoutGrid, Menu, MessagesSquare, Minimize2, Moon, Search, Sun, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Avatar, Button, cn, Kbd, MenuItem, Modal, Popover, Spinner, Textarea } from '@/components/ui'
import { api, setBreakGlassHandler } from '@/lib/api'
import { useAuth, useBranch, useMeta, useRegistry } from '@/lib/auth'
import { getChrome, openLauncher, openPalette, openShortcutHelp, setChrome, toggleFocus, useChrome } from '@/lib/chrome'
import { Icon } from '@/lib/icons'
import { useRealtime } from '@/lib/realtime'
import { isMac, isTyping } from '@/lib/shortcuts'
import { useOnline } from '@/lib/downtime'
import { AppLauncher } from './AppLauncher'
import { CommandPalette, pushRecent } from './CommandPalette'
import { ShortcutHelp } from './ShortcutHelp'

function useTheme() {
  const [dark, setDark] = useState(() => {
    try { const s = localStorage.getItem('vlack.theme'); return s ? s === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('vlack.theme', dark ? 'dark' : 'light') } catch { /* ignore */ }
  }, [dark])
  return [dark, setDark] as const
}

function readOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem('vlack.suites') ?? '{}') } catch { return {} }
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { meta, modules } = useRegistry()
  const loc = useLocation()
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen)
  const [filter, setFilter] = useState('')
  const activeModule = loc.pathname.startsWith('/m/') ? loc.pathname.split('/')[2] : null
  useEffect(() => { try { localStorage.setItem('vlack.suites', JSON.stringify(open)) } catch { /* ignore */ } }, [open])
  const f = filter.trim().toLowerCase()
  const bySuite = useMemo(() => {
    const out = new Map<string, typeof modules>()
    for (const m of modules) {
      if (f && !`${m.no} ${m.name} ${m.summary}`.toLowerCase().includes(f)) continue
      out.set(m.suite, [...(out.get(m.suite) ?? []), m])
    }
    return out
  }, [modules, f])

  const link = 'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm'
  return (
    <nav className="flex h-full flex-col bg-brand-950 text-slate-200">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <img src="/favicon.svg" alt="" className="size-8" />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold text-white">Vlack HRMS</div>
          <div className="max-w-44 truncate text-[11px] text-cyan-200/70">{meta?.hospital.name}</div>
        </div>
      </Link>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-slate-400" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a module…"
            className="h-8 w-full rounded-lg bg-white/10 pl-8 pr-2 text-sm text-white placeholder:text-slate-400 outline-none focus:bg-white/15" />
        </div>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4 scroll-thin">
        <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-amber-300/90">
          <span className="size-1.5 rounded-full bg-amber-300" /> {meta?.roles[meta.user.perm_role ?? meta.user.role] ?? meta?.user.role}
        </div>
        <NavLink to="/" end onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
          <Icon name="LayoutDashboard" className="size-4" /> Dashboard
        </NavLink>
        <NavLink to="/modules" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
          <LayoutGrid className="size-4" /> All modules <span className="ml-auto text-[11px] text-slate-400">{modules.length}</span>
        </NavLink>
        <NavLink to="/messages" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
          <MessagesSquare className="size-4" /> Messages <UnreadPill />
        </NavLink>
        <NavLink to="/support" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
          <Icon name="LifeBuoy" className="size-4" /> Support
        </NavLink>
        {meta?.suites.map((s) => {
          const mods = bySuite.get(s.id) ?? []
          if (!mods.length) return null
          const isOpen = f ? true : open[s.id] ?? mods.some((m) => m.id === activeModule)
          return (
            <div key={s.id} className="pt-2">
              <button onClick={() => setOpen({ ...open, [s.id]: !isOpen })}
                className="flex w-full items-center justify-between px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-200/60 hover:text-cyan-100">
                {s.short}
                <ChevronDown className={cn('size-3.5 transition-transform', !isOpen && '-rotate-90')} />
              </button>
              {isOpen && mods.map((m) => (
                <NavLink key={m.id} to={`/m/${m.id}`} onClick={onNavigate}
                  className={({ isActive }) => cn(link, 'py-1', isActive ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white')}>
                  <Icon name={m.icon} className="size-4 shrink-0 opacity-80" />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-slate-500">{m.no}</span>
                </NavLink>
              ))}
            </div>
          )
        })}
        {meta?.user.role === 'admin' && (
          <div className="pt-3">
            <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-200/60">Administration</div>
            <NavLink to="/admin/users" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
              <Icon name="UsersRound" className="size-4" /> Users
            </NavLink>
            <NavLink to="/admin/roles" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
              <Icon name="ShieldCheck" className="size-4" /> Roles & permissions
            </NavLink>
            <NavLink to="/admin/config" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
              <Icon name="SlidersHorizontal" className="size-4" /> Field configuration
            </NavLink>
            <NavLink to="/admin/audit" onClick={onNavigate} className={({ isActive }) => cn(link, isActive ? 'bg-white/15 text-white' : 'hover:bg-white/10')}>
              <Icon name="History" className="size-4" /> Audit trail
            </NavLink>
          </div>
        )}
      </div>
    </nav>
  )
}

function SearchTrigger() {
  return (
    <button type="button" onClick={openPalette}
      className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-line-2 bg-surface px-3 text-left text-sm text-ink-3 shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] hover:border-brand-600/50">
      <Search className="size-4 shrink-0" />
      <span className="flex-1 truncate">Search pages, patients, actions…</span>
      <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
    </button>
  )
}

function BranchSwitcher() {
  const { branches, current, branch, switchBranch } = useBranch()
  const label = current?.name ?? branch ?? '—'
  if (branches.length <= 1) {
    return (
      <span className="hidden max-w-52 items-center gap-1.5 truncate rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-700/15 md:inline-flex dark:bg-brand-500/10 dark:text-brand-200"
        title={`Branch: ${label}`}>
        <Building2 className="size-3.5 shrink-0" /> <span className="truncate">{label}</span>
      </span>
    )
  }
  return (
    <Popover align="left" className="w-72" trigger={({ toggle, open }) => (
      <button type="button" onClick={toggle} aria-expanded={open} aria-label={`Branch: ${label}. Switch branch`}
        className="inline-flex max-w-56 items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-700/15 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-200">
        <Building2 className="size-3.5 shrink-0" /> <span className="truncate">{label}</span> <ChevronDown className="size-3.5 shrink-0" />
      </button>
    )}>
      {(close) => (
        <>
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Switch branch</div>
          {branches.map((b) => (
            <button key={b.code} type="button" onClick={() => { close(); if (b.code !== branch) { switchBranch(b.code); toast.success(`Switched to ${b.name}`) } }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2">
              <span className="grid size-7 place-items-center rounded-md bg-surface-2 font-mono text-[11px] text-ink-2 ring-1 ring-line">{String(b.no).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{b.name}</span>
                <span className="block text-xs text-ink-3">{[b.code, b.city].filter(Boolean).join(' · ')}</span>
              </span>
              {b.code === branch && <Check className="size-4 text-brand-700" />}
            </button>
          ))}
          <p className="border-t border-line px-3 pb-1 pt-2 text-[11px] text-ink-3">Work lists and new records follow the active branch; masters and patient records are shared.</p>
        </>
      )}
    </Popover>
  )
}

export function useMessageCounts() {
  const { token } = useAuth()
  return useQuery({
    queryKey: ['messages', 'counts'],
    queryFn: () => api<{ unread: number; mentions: number; urgent: number; tasks_open: number; drafts: number }>('/messages/counts'),
    enabled: !!token,
    refetchInterval: 120_000,
    staleTime: 20_000,
  })
}

function UnreadPill() {
  const n = useMessageCounts().data?.unread ?? 0
  if (!n) return null
  return <span className="ml-auto rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-amber-950">{n > 99 ? '99+' : n}</span>
}

function MessagesButton() {
  const nav = useNavigate()
  const c = useMessageCounts().data
  const n = c?.unread ?? 0
  return (
    <button className="relative rounded-lg p-2 text-ink-2 hover:bg-surface-2" onClick={() => nav('/messages')}
      aria-label={`Messages${n ? `, ${n} unread` : ''}`} title={n ? `${n} unread message${n > 1 ? 's' : ''}${c?.urgent ? ` · ${c.urgent} urgent` : ''}` : 'Messages'}>
      <MessagesSquare className="size-5" />
      {n > 0 && <span className={cn('absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white', c?.urgent ? 'bg-red-600' : 'bg-brand-700')}>{n > 9 ? '9+' : n}</span>}
    </button>
  )
}

/** Global keys: ⌘K palette · Ctrl+G launcher · / list search · ? help · Shift+F focus · Esc leaves focus mode. */
function useGlobalKeys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); const c = getChrome(); setChrome({ palette: !c.palette, launcher: false }); return }
      if (e.ctrlKey && k === 'g') { e.preventDefault(); const c = getChrome(); setChrome({ launcher: !c.launcher, palette: false }); return }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return
      const dialogOpen = !!document.querySelector('[role="dialog"]')
      if (e.key === '/' && !dialogOpen) {
        const box = Array.from(document.querySelectorAll<HTMLInputElement>('[data-list-search]')).find((el) => el.offsetParent !== null)
        e.preventDefault()
        if (box) { box.focus(); box.select() } else openPalette()
      } else if (e.key === '?' && !dialogOpen) { e.preventDefault(); openShortcutHelp() }
      else if (e.key === 'F' && e.shiftKey && !dialogOpen) { e.preventDefault(); toggleFocus() }
      else if (e.key === 'Escape' && !dialogOpen && getChrome().focus) setChrome({ focus: false })
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
}

function ApprovalsBell() {
  const reg = useRegistry()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ['approvals', 'count'],
    queryFn: () => api<{ pending: number }>('/workflow/inbox/count'),
    enabled: reg.canPage('workflow', 'approvals-inbox'),
    refetchInterval: 60_000,
  })
  if (!reg.canPage('workflow', 'approvals-inbox')) return null
  const n = q.data?.pending ?? 0
  return (
    <button className="relative rounded-lg p-2 text-ink-2 hover:bg-surface-2" onClick={() => nav('/m/workflow/approvals-inbox')} aria-label="Approvals">
      <Bell className="size-5" />
      {n > 0 && <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{n}</span>}
    </button>
  )
}

function BreakGlassPrompt() {
  const [req, setReq] = useState<{ message: string; resolve: (v: string | null) => void } | null>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    setBreakGlassHandler((message) => new Promise((resolve) => { setReason(''); setReq({ message, resolve }) }))
  }, [])
  if (!req) return null
  const close = (v: string | null) => { req.resolve(v); setReq(null) }
  return (
    <Modal open onClose={() => close(null)} title="Break the glass" size="sm"
      footer={<>
        <Button variant="ghost" onClick={() => close(null)}>Cancel</Button>
        <Button variant="danger" disabled={reason.trim().length < 10} onClick={() => close(reason.trim())}>Open restricted record</Button>
      </>}>
      <p className="text-sm text-ink-2">{req.message}</p>
      <p className="mt-2 text-sm text-ink-2">Your name, role, time and reason are written to the audit trail and the record owner is alerted.</p>
      <Textarea className="mt-3" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Clinical reason (min. 10 characters)" autoFocus />
    </Modal>
  )
}

export function AppShell() {
  const { user, logout } = useAuth()
  const meta = useMeta()
  const reg = useRegistry()
  const nav = useNavigate()
  const [dark, setDark] = useTheme()
  const [mobileNav, setMobileNav] = useState(false)
  const [menu, setMenu] = useState(false)
  const online = useOnline()
  const { focus } = useChrome()
  const loc = useLocation()
  useRealtime(!!meta.data, meta.data?.user.role)
  useGlobalKeys()
  useEffect(() => { pushRecent(loc.pathname) }, [loc.pathname])
  const me = meta.data?.user ?? user

  if (meta.isLoading) return <div className="grid h-full place-items-center"><Spinner label="Loading Vlack HRMS…" /></div>

  return (
    <div className="flex h-full">
      {focus && (
        <button onClick={toggleFocus} className="no-print fixed right-3 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-xs font-medium text-ink-2 shadow-lg hover:text-ink"
          title="Exit focus mode (Esc)">
          <Minimize2 className="size-3.5" /> Exit focus
        </button>
      )}
      <aside className={cn('no-print hidden w-64 shrink-0', !focus && 'lg:block')}>
        <div className="fixed inset-y-0 w-64"><Sidebar /></div>
      </aside>
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileNav(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="absolute inset-y-0 left-0 w-72" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setMobileNav(false)} />
            <button className="absolute right-2 top-3 text-white" onClick={() => setMobileNav(false)} aria-label="Close menu"><X className="size-5" /></button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={cn('no-print sticky top-0 z-20 h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur', focus ? 'hidden' : 'flex')}>
          <button className="rounded-lg p-2 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <BranchSwitcher />
          <SearchTrigger />
          <div className="ml-auto flex items-center gap-1">
            {reg.canPage('registration', 'patient-registration', 'edit') && (
              <Button size="sm" variant="primary" className="hidden sm:inline-flex" onClick={() => nav('/m/registration/patient-registration')}>
                <UserPlus className="size-4" /> Register
              </Button>
            )}
            <button className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" onClick={openLauncher} aria-label="App Launcher (Ctrl+G)" title="App Launcher (Ctrl+G)">
              <LayoutGrid className="size-5" />
            </button>
            <MessagesButton />
            <ApprovalsBell />
            <button className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" onClick={() => setDark(!dark)} aria-label="Toggle theme">
              {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
            <div className="relative">
              <button className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-2" onClick={() => setMenu(!menu)}>
                <Avatar name={me?.name} size="sm" />
                <span className="hidden text-left leading-tight md:block">
                  <span className="block max-w-44 truncate text-sm font-medium text-ink">{me?.name}</span>
                  <span className="block text-[11px] text-ink-3">{reg.roleLabel(me)}</span>
                </span>
                <ChevronDown className="size-4 text-ink-3" />
              </button>
              {menu && (
                <div className="absolute right-0 z-40 mt-1 w-60 rounded-xl border border-line bg-surface py-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
                  <div className="border-b border-line px-3 pb-2 pt-1.5">
                    <div className="truncate text-sm font-medium text-ink">{me?.name}</div>
                    <div className="truncate text-xs text-ink-3">{me?.username} · {reg.roleLabel(me)}</div>
                  </div>
                  {reg.canPage('ess', 'self-service') && (
                    <MenuItem icon="UserRound" onClick={() => { setMenu(false); nav('/m/ess/self-service') }}>My self-service</MenuItem>
                  )}
                  {(reg.canPage('opd', 'consultation-format') || me?.role === 'admin') && (
                    <MenuItem icon="SlidersHorizontal" onClick={() => { setMenu(false); nav('/settings/consultation-format') }}>My consultation format</MenuItem>
                  )}
                  <MenuItem icon="MonitorSmartphone" onClick={() => { setMenu(false); nav('/account/sessions') }}>Devices & sessions</MenuItem>
                  <MenuItem icon="Keyboard" hint="?" onClick={() => { setMenu(false); openShortcutHelp() }}>Keyboard shortcuts</MenuItem>
                  <MenuItem icon="LifeBuoy" onClick={() => { setMenu(false); nav('/support') }}>Help & support</MenuItem>
                  <div className="my-1 border-t border-line" />
                  <MenuItem icon="LogOut" danger onClick={() => logout().then(() => nav('/login'))}>Sign out</MenuItem>
                </div>
              )}
            </div>
          </div>
        </header>
        {!online && (
          <div role="status" className="no-print flex items-center gap-2 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950">
            <Icon name="WifiOff" className="size-4" /> Downtime mode — showing the last synced data read-only. Changes cannot be saved until the connection returns.
          </div>
        )}
        <main className={cn('mx-auto w-full flex-1 p-4 md:p-6', focus ? 'max-w-none' : 'max-w-[1600px]')}>
          <Outlet />
        </main>
      </div>
      <BreakGlassPrompt />
      <CommandPalette onToggleTheme={() => setDark(!dark)} />
      <AppLauncher />
      <ShortcutHelp />
    </div>
  )
}
