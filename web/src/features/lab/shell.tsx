import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { cn, Empty, PageHeader, Spinner } from '@/components/ui'
import { useRegistry } from '@/lib/auth'
import { Icon } from '@/lib/icons'

/**
 * Who may use which laboratory screen. Mirrors the server (labsuite.py): the roles & permissions matrix
 * decides visibility; the orders engine's role rules (collect: lab / nurse; receive & result: lab;
 * authorise: lab / doctor) decide which actions are offered. A screen or action that would end in a
 * 403 is never shown.
 */
export function useLabAccess() {
  const reg = useRegistry()
  const role = reg.meta?.user.role ?? ''
  const admin = role === 'admin'
  const benchEditPage = reg.canPage('lab', 'lab-worklist', 'edit')
  return {
    ready: !!reg.meta,
    role,
    desk: reg.canPage('lab', 'lab-desk'),
    worklist: reg.canPage('lab', 'lab-worklist'),
    services: reg.canEntity('lab.tests'),
    servicesEdit: reg.canEntity('lab.tests', 'write'),
    collect: (admin || role === 'lab' || role === 'nurse') && (reg.entityLevel('orders.orders') === 'edit' || reg.entityLevel('lab.lab_orders') === 'edit'),
    bench: reg.canPage('lab', 'lab-worklist'),
    benchEdit: benchEditPage && (admin || role === 'lab'),
    verify: benchEditPage && (admin || role === 'lab' || role === 'doctor'),
    reports: reg.canEntity('lab.lab_orders'),
    rollback: benchEditPage && (admin || role === 'lab'),
    rejected: reg.canEntity('lab.samples'),
    track: reg.canEntity('lab.lab_orders'),
    setup: reg.canPage('lab', 'lab-worklist') && reg.canEntity('lab.ref_ranges'),
  }
}

export type LabAccess = ReturnType<typeof useLabAccess>
export type LabGate = Exclude<keyof LabAccess, 'ready' | 'role'>

export interface LabScreen { key: string; label: string; path: string; icon: string; gate: LabGate; group: string; hint: string }

export const LAB_SCREENS: LabScreen[] = [
  { key: 'worklist', label: 'Worklist', path: '/m/lab/lab-worklist', icon: 'TestTubes', gate: 'worklist', group: 'Laboratory', hint: 'Collect, receive, result and authorise' },
  { key: 'services', label: 'All services', path: '/lab/services', icon: 'BookOpen', gate: 'services', group: 'Laboratory', hint: 'Test catalogue: sections, sample, container, TAT, rates' },
  { key: 'collection', label: 'Sample collection', path: '/lab/collection', icon: 'Syringe', gate: 'collect', group: 'Laboratory', hint: 'Bulk collection by patient or ward with labels' },
  { key: 'accept', label: 'Accept samples', path: '/lab/accept', icon: 'PackageCheck', gate: 'bench', group: 'Laboratory', hint: 'Scan tubes in; reject unfit samples' },
  { key: 'results', label: 'Result entry & verify', path: '/lab/results', icon: 'ClipboardPen', gate: 'bench', group: 'Laboratory', hint: 'Worksheets by section / analyser, delta and reflex checks' },
  { key: 'authorized', label: 'Authorised reports', path: '/lab/authorized', icon: 'FileCheck2', gate: 'reports', group: 'Laboratory', hint: 'View, print, smart report, roll back' },
  { key: 'rejected', label: 'Rejected reports', path: '/lab/rejected', icon: 'FileX2', gate: 'rejected', group: 'Laboratory', hint: 'Rejected samples, re-runs, cancellations, roll-backs' },
  { key: 'track', label: 'Track samples', path: '/lab/track', icon: 'Route', gate: 'track', group: 'Laboratory', hint: 'Chain of custody per barcode' },
  { key: 'micro', label: 'Microbiology', path: '/lab/micro', icon: 'Microscope', gate: 'bench', group: 'Specialised entry', hint: 'Culture, colony count, antibiotic sensitivity' },
  { key: 'outsourcing', label: 'Out-sourcing', path: '/lab/outsourcing', icon: 'Truck', gate: 'bench', group: 'Specialised entry', hint: 'Send-outs to reference labs, report receipt' },
  { key: 'cancellation', label: 'Result cancellation', path: '/lab/cancellation', icon: 'Ban', gate: 'benchEdit', group: 'Specialised entry', hint: 'Withdraw a result with an audited reason' },
  { key: 'setup', label: 'Lab setup', path: '/lab/setup', icon: 'Settings2', gate: 'setup', group: 'Lab setup', hint: 'Sections, analysers, ranges, rules, formats' },
]

/** Header + the lab's own navigation (only the screens this role can use) + an access guard. */
export function LabShell({ screen, title, subtitle, icon, actions, badge, children }: {
  screen: string; title: string; subtitle?: ReactNode; icon: string; actions?: ReactNode; badge?: ReactNode; children: ReactNode
}) {
  const acc = useLabAccess()
  if (!acc.ready) return <Spinner />
  const current = LAB_SCREENS.find((s) => s.key === screen)
  const allowed = LAB_SCREENS.filter((s) => acc[s.gate])
  return (
    <div>
      <PageHeader icon={icon} title={title} subtitle={subtitle} actions={current && acc[current.gate] ? actions : undefined} badge={badge} />
      {allowed.length > 1 && (
        <nav aria-label="Laboratory screens" className="no-print -mt-1 mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 scroll-thin">
          {allowed.map((s) => (
            <NavLink key={s.key} to={s.path} title={s.hint}
              className={({ isActive }) => cn('inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium',
                isActive ? 'bg-brand-700 text-white' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
              <Icon name={s.icon} className="size-3.5" />{s.label}
            </NavLink>
          ))}
        </nav>
      )}
      {current && !acc[current.gate]
        ? <Empty icon="Lock" title="Not available for your role">Ask the administrator if you need this laboratory screen.</Empty>
        : children}
    </div>
  )
}

/** Compact KPI chip used in the screen headers (mirrors the reference's top-right counters). */
export function Kpi({ icon, label, value, tone }: { icon: string; label: string; value: ReactNode; tone?: 'alert' | 'ok' }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-xl border bg-surface px-3 py-1.5',
      tone === 'alert' ? 'border-red-300 dark:border-red-500/40' : 'border-line')}>
      <span className={cn('grid size-7 place-items-center rounded-lg',
        tone === 'alert' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300')}>
        <Icon name={icon} className="size-4" />
      </span>
      <span className="leading-tight">
        <span className="block text-base font-semibold tabular text-ink">{value}</span>
        <span className="block text-[11px] text-ink-3">{label}</span>
      </span>
    </div>
  )
}
