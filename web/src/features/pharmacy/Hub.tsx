import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { PHARM_SCREENS, usePharmAccess } from './shell'

interface Summary { bills: number; sales: number; collected: number; refunds: number; due_bills: number; due_amount: number; drafts: number; returns_pending: number
  open_shifts: number; my_shift: { counter: string; opened_at: string } | null }

/** OP pharmacy launcher: the counter screens this role can use, with today's figures. */
export default function PharmacyHub() {
  const acc = usePharmAccess()
  const q = useQuery({ queryKey: ['x', 'pharmacy', 'summary'], queryFn: () => api<Summary>('/op-pharmacy/summary'), enabled: acc.reports, refetchInterval: 60_000 })
  if (!acc.ready) return <Spinner />
  const s = q.data
  const facts: Record<string, string | undefined> = s ? {
    counter: s.my_shift ? `${s.my_shift.counter} open since ${dateTime(s.my_shift.opened_at)}` : 'No open shift',
    bills: `${s.bills} bills · ${money(s.sales, true)} today`, dues: `${s.due_bills} bills · ${money(s.due_amount, true)} due`,
    returns: `${s.returns_pending} awaiting approval`, shift: `${s.open_shifts} counter${s.open_shifts === 1 ? '' : 's'} open`,
    collections: `${money(s.collected, true)} collected today`,
  } : {}
  return (
    <div className="space-y-4">
      {q.error && <ErrorBox error={q.error} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {PHARM_SCREENS.filter((x) => acc[x.gate]).map((x) => (
          <Link key={x.key} to={x.path} className="group flex gap-3 rounded-xl border border-line bg-surface p-3 hover:border-brand-600/40 hover:bg-surface-2">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-300"><Icon name={x.icon} className="size-5" /></span>
            <span className="min-w-0"><span className="block font-medium text-ink group-hover:underline">{x.label}</span><span className="block text-xs text-ink-3">{x.hint}</span>
              {facts[x.key] && <span className="mt-1 block text-sm text-ink-2">{facts[x.key]}</span>}</span>
          </Link>
        ))}
      </div>
      {s && s.drafts > 0 && <Link to="/pharmacy/bills?status=Draft" className="text-sm text-brand-700 hover:underline dark:text-brand-300">{s.drafts} parked draft bill{s.drafts > 1 ? 's' : ''} →</Link>}
    </div>
  )
}
