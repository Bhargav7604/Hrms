import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronDown, FileText, Home as HomeIcon, LogOut, Menu, ReceiptIndianRupee, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router'
import { Avatar, Badge, Button, cn, ErrorBox, Spinner } from '@/components/ui'
import { getPortalToken, setPortalToken } from '@/lib/api'
import { Appointments, BookAppointment } from './Appointments'
import { Consents } from './Consents'
import { Home } from './Home'
import { allowed, papi, PORTAL_LOGOUT, PortalContext, SCOPES, usePortal, type Me, type PortalState } from './lib'
import PortalLogin from './Login'
import { Feedback, MoreMenu, ProfilePage, Teleconsults } from './More'
import { BillDetail, Bills, Prescriptions, ReportDetail, Reports } from './Records'

/** Patient portal & app (mounted at /portal/*): OTP login, family switcher and self-service pages. */

const PID_KEY = 'vlack.portal.pid'
const readPid = () => { try { return sessionStorage.getItem(PID_KEY) } catch { return null } }
const savePid = (v: string) => { try { sessionStorage.setItem(PID_KEY, v) } catch { /* storage unavailable */ } }

export default function PortalApp() {
  const qc = useQueryClient()
  const [token, setToken] = useState<string | null>(() => getPortalToken())
  const signOut = useCallback(() => {
    setPortalToken(null)
    setToken(null)
    qc.removeQueries({ queryKey: ['portal'] })
  }, [qc])
  useEffect(() => {
    window.addEventListener(PORTAL_LOGOUT, signOut)
    return () => window.removeEventListener(PORTAL_LOGOUT, signOut)
  }, [signOut])

  if (!token) {
    return <PortalLogin onLoggedIn={(r) => { setPortalToken(r.token); setToken(r.token); try { sessionStorage.setItem(PID_KEY, r.patient.id) } catch { /* ignore */ } }} />
  }
  return <Shell onSignOut={signOut} />
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => papi<Me>('/me'), staleTime: 60_000 })
  const [pid, setPidState] = useState<string | null>(readPid)
  const [switcher, setSwitcher] = useState(false)

  const logout = useCallback(() => {
    papi('/logout', { method: 'POST' }).catch(() => { /* token may already be invalid */ }).finally(onSignOut)
  }, [onSignOut])

  const state = useMemo<PortalState | null>(() => {
    if (!me.data) return null
    const profile = me.data.profiles.find((p) => p.id === pid) ?? me.data.profiles.find((p) => p.self) ?? me.data.profiles[0]
    return {
      me: me.data, pid: profile.id, profile, logout,
      setPid: (id: string) => { savePid(id); setPidState(id); setSwitcher(false) },
    }
  }, [me.data, pid, logout])

  useEffect(() => { if (me.data) document.title = `Patient portal · ${me.data.hospital.name}` }, [me.data])

  if (me.isLoading) return <div className="grid min-h-full place-items-center bg-plane"><Spinner label="Opening your records…" /></div>
  if (me.error || !state) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-6">
        <ErrorBox error={me.error ?? 'Could not load your profile'} />
        <Button variant="primary" onClick={onSignOut}>Sign in again</Button>
      </div>
    )
  }
  const p = state.profile
  const nav = [
    { to: '/portal', label: 'Home', icon: HomeIcon, end: true, show: true },
    { to: '/portal/appointments', label: 'Visits', icon: CalendarDays, show: allowed(p, SCOPES.appointments) },
    { to: '/portal/reports', label: 'Reports', icon: FileText, show: allowed(p, SCOPES.reports) },
    { to: '/portal/bills', label: 'Bills', icon: ReceiptIndianRupee, show: allowed(p, SCOPES.bills) },
    { to: '/portal/more', label: 'More', icon: Menu, show: true },
  ].filter((n) => n.show)

  return (
    <PortalContext.Provider value={state}>
      <div className="min-h-full bg-plane pb-20 md:pb-8">
        <header className="no-print sticky top-0 z-20 bg-brand-900 text-white shadow">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
            <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{state.me.hospital.name}</div>
              <div className="text-[11px] text-cyan-100/70">Patient portal</div>
            </div>
            <button onClick={() => setSwitcher((v) => !v)} aria-expanded={switcher} aria-haspopup="menu"
              className="flex min-w-0 items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-2.5 text-left hover:bg-white/15">
              <Avatar name={p.name} size="sm" />
              <span className="min-w-0 max-w-32 truncate text-sm sm:max-w-48">{p.name}</span>
              {state.me.profiles.length > 1 && <ChevronDown className="size-4 shrink-0" />}
            </button>
            <button onClick={logout} className="rounded-full p-2 hover:bg-white/10" aria-label="Sign out" title="Sign out"><LogOut className="size-5" /></button>
          </div>
          <nav className="mx-auto hidden max-w-3xl gap-1 px-4 md:flex" aria-label="Portal">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}
                className={({ isActive }) => cn('flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', isActive ? 'border-cyan-300 text-white' : 'border-transparent text-cyan-100/80 hover:text-white')}>
                <n.icon className="size-4" /> {n.label}
              </NavLink>
            ))}
          </nav>
        </header>

        {switcher && (
          <div className="no-print fixed inset-0 z-30 bg-slate-950/40" onClick={() => setSwitcher(false)}>
            <div role="menu" className="mx-auto mt-16 max-w-sm rounded-2xl border border-line bg-surface p-2 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3"><Users className="size-4" /> Switch profile</div>
              {state.me.profiles.map((pr) => (
                <button key={pr.id} role="menuitemradio" aria-checked={pr.id === p.id} onClick={() => state.setPid(pr.id)}
                  className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2', pr.id === p.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                  <Avatar name={pr.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{pr.name}</span>
                    <span className="block truncate text-xs text-ink-3">{pr.uhid} · {pr.relation}</span>
                  </span>
                  {!pr.scopes.includes('Full access') && <Badge tone="amber">Limited</Badge>}
                </button>
              ))}
              <p className="px-3 py-2 text-xs text-ink-3">Family members appear here when the hospital links them to you with portal access.</p>
            </div>
          </div>
        )}

        {!p.self && (
          <div className="no-print border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="mx-auto max-w-3xl px-4 py-1.5 text-xs">Viewing <b>{p.name}</b> ({p.relation}){!p.scopes.includes('Full access') && ` — access to ${p.scopes.join(', ').toLowerCase()}`}</div>
          </div>
        )}

        <main className="mx-auto max-w-3xl px-4 py-4">
          <Routes>
            <Route index element={<Home />} />
            <Route path="appointments" element={<Guard scope={SCOPES.appointments}><Appointments /></Guard>} />
            <Route path="appointments/book" element={<Guard scope={SCOPES.appointments}><BookAppointment /></Guard>} />
            <Route path="reports" element={<Guard scope={SCOPES.reports}><Reports /></Guard>} />
            <Route path="reports/:id" element={<Guard scope={SCOPES.reports}><ReportDetail /></Guard>} />
            <Route path="bills" element={<Guard scope={SCOPES.bills}><Bills /></Guard>} />
            <Route path="bills/:id" element={<Guard scope={SCOPES.bills}><BillDetail /></Guard>} />
            <Route path="prescriptions" element={<Guard scope={SCOPES.rx}><Prescriptions /></Guard>} />
            <Route path="consents" element={<Guard scope={SCOPES.consent}><Consents /></Guard>} />
            <Route path="teleconsults" element={<Guard scope={SCOPES.tele}><Teleconsults /></Guard>} />
            <Route path="feedback" element={<Feedback />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="more" element={<MoreMenu />} />
            <Route path="*" element={<Navigate to="/portal" replace />} />
          </Routes>
        </main>

        <nav className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur md:hidden" aria-label="Portal">
          <div className="mx-auto grid max-w-md" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}
                className={({ isActive }) => cn('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-brand-700 dark:text-brand-300' : 'text-ink-3')}>
                <n.icon className="size-5" /> {n.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </PortalContext.Provider>
  )
}

function Guard({ scope, children }: { scope: string; children: ReactNode }) {
  const { profile } = usePortal()
  if (!allowed(profile, scope)) {
    return <div className="rounded-xl border border-line bg-surface p-6 text-center text-sm text-ink-2">Your access to {profile.name} does not include {scope.toLowerCase()}.</div>
  }
  return children
}
