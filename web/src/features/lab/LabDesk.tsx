import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { cn, ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { LAB_SCREENS, useLabAccess } from './shell'

interface Desk {
  to_collect: number; recollect: number; in_transit: number; in_process: number; to_verify: number; authorised_today: number; critical_unack: number
  delta_holds: number; rejected_today: number; cancelled_today: number; outsourced_pending?: number; overdue: number; stat: number; micro_pending: number; generated_at: string
}

const COUNT: Record<string, (d: Desk) => { value: number; label: string; alert?: boolean } | null> = {
  worklist: (d) => ({ value: d.overdue, label: 'past TAT', alert: d.overdue > 0 }),
  collection: (d) => ({ value: d.to_collect, label: d.recollect ? `to collect · ${d.recollect} recollect` : 'to collect', alert: d.recollect > 0 }),
  accept: (d) => ({ value: d.in_transit, label: 'in transit' }),
  results: (d) => ({ value: d.in_process + d.to_verify, label: `${d.to_verify} to authorise${d.delta_holds ? ` · ${d.delta_holds} delta hold` : ''}`, alert: d.delta_holds > 0 }),
  authorized: (d) => ({ value: d.authorised_today, label: 'released today' }),
  rejected: (d) => ({ value: d.rejected_today + d.cancelled_today, label: 'today' }),
  micro: (d) => ({ value: d.micro_pending, label: 'cultures at the bench' }),
  outsourcing: (d) => ({ value: d.outsourced_pending ?? 0, label: 'pending' }),
}

/** The laboratory's own launcher: every lab screen this role can use, with live counts. */
export default function LabDesk() {
  const acc = useLabAccess()
  const q = useQuery({ queryKey: ['x', 'lab', 'desk'], queryFn: () => api<Desk>('/lab/desk'), refetchInterval: 30_000 })
  if (!acc.ready) return <Spinner />
  const screens = LAB_SCREENS.filter((s) => acc[s.gate])
  const groups = [...new Set(screens.map((s) => s.group))]
  const d = q.data
  return (
    <div className="space-y-5">
      {q.error && <ErrorBox error={q.error} />}
      {d && (d.critical_unack > 0 || d.stat > 0) && (
        <div className="flex flex-wrap gap-2">
          {d.stat > 0 && <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white"><Icon name="Siren" className="size-4" />{d.stat} STAT pending</span>}
          {d.critical_unack > 0 && <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"><Icon name="BellRing" className="size-4" />{d.critical_unack} critical results not yet acknowledged by clinicians</span>}
        </div>
      )}
      {groups.map((g) => (
        <section key={g}>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3"><span className="h-3 w-1 rounded-full bg-brand-600" />{g}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {screens.filter((s) => s.group === g).map((s) => {
              const c = d ? COUNT[s.key]?.(d) : null
              return (
                <Link key={s.key} to={s.path} className="group flex gap-3 rounded-xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-brand-600/40 hover:bg-surface-2">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-300"><Icon name={s.icon} className="size-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink group-hover:underline">{s.label}</span>
                    <span className="block text-xs text-ink-3">{s.hint}</span>
                    {c && <span className={cn('mt-1 block text-sm tabular', c.alert ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ink-2')}><b className="text-ink">{c.value}</b> {c.label}</span>}
                  </span>
                </Link>
              )
            })}
          </div>
        </section>
      ))}
      {d && <p className="text-xs text-ink-3">Live · updated {time(d.generated_at)}</p>}
    </div>
  )
}
