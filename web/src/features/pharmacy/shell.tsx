import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { cn, Empty, PageHeader, Spinner } from '@/components/ui'
import { useRegistry } from '@/lib/auth'
import { Icon } from '@/lib/icons'

/**
 * Who may use the OP pharmacy counter. Mirrors pharmacycounter.py: selling, collecting, returns and
 * shifts need the "OP Pharmacy" workspace at edit level plus write on pharmacy bills; the reports need
 * read on pharmacy bills (pharmacist, management by default). Nothing is shown that would end in a 403.
 */
export function usePharmAccess() {
  const reg = useRegistry()
  // counter bills are engine-managed (no generic create), so "edit" level — not `write` — is what selling needs
  const sell = reg.canPage('pharmacy', 'op-pharmacy', 'edit') && reg.entityLevel('pharmacy.counter_bills') === 'edit'
  return {
    ready: !!reg.meta,
    role: reg.meta?.user.role ?? '',
    sell,
    hub: reg.canPage('pharmacy', 'op-pharmacy'),
    reports: reg.canEntity('pharmacy.counter_bills'),
    shifts: reg.canEntity('pharmacy.shifts'),
    returns: reg.canEntity('pharmacy.counter_returns'),
    orgs: reg.canEntity('pharmacy.credit_orgs'),
    margin: reg.canEntity('pharmacy.margin_discounts'),
  }
}
export type PharmAccess = ReturnType<typeof usePharmAccess>
type Gate = Exclude<keyof PharmAccess, 'ready' | 'role'>

export interface PharmScreen { key: string; label: string; path: string; icon: string; gate: Gate; hint: string }
export const PHARM_SCREENS: PharmScreen[] = [
  { key: 'counter', label: 'Pharmacy billing', path: '/pharmacy/counter', icon: 'ShoppingCart', gate: 'sell', hint: 'Walk-in, prescription and credit sales' },
  { key: 'bills', label: 'Bills report', path: '/pharmacy/bills', icon: 'ReceiptText', gate: 'reports', hint: 'Bills, drafts and cancellations with GST totals' },
  { key: 'dues', label: 'Due bills', path: '/pharmacy/dues', icon: 'HandCoins', gate: 'reports', hint: 'Balances due with ageing; collect dues' },
  { key: 'returns', label: 'Returns', path: '/pharmacy/returns', icon: 'Undo2', gate: 'returns', hint: 'New return and return approval' },
  { key: 'shift', label: 'Shift summary', path: '/pharmacy/shift', icon: 'Clock', gate: 'shifts', hint: 'Open / close the counter with a cash count' },
  { key: 'collections', label: 'User collection', path: '/pharmacy/collections', icon: 'Wallet', gate: 'reports', hint: 'Collections by user and payment mode' },
  { key: 'orgs', label: 'Credit organisations', path: '/m/pharmacy/credit_orgs', icon: 'Building2', gate: 'orgs', hint: 'Corporate / staff / scheme credit, co-pay and limits' },
  { key: 'margin', label: 'Margin discount config', path: '/m/pharmacy/margin_discounts', icon: 'Percent', gate: 'margin', hint: 'Discount allowed by margin band' },
]

export function PharmShell({ screen, title, subtitle, icon, actions, children }: {
  screen: string; title: string; subtitle?: ReactNode; icon: string; actions?: ReactNode; children: ReactNode
}) {
  const acc = usePharmAccess()
  if (!acc.ready) return <Spinner />
  const current = PHARM_SCREENS.find((s) => s.key === screen)
  const allowed = PHARM_SCREENS.filter((s) => acc[s.gate])
  const ok = !current || acc[current.gate]
  return (
    <div>
      <PageHeader icon={icon} title={title} subtitle={subtitle} actions={ok ? actions : undefined} />
      {allowed.length > 1 && (
        <nav aria-label="OP pharmacy screens" className="no-print -mt-1 mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 scroll-thin">
          {allowed.map((s) => (
            <NavLink key={s.key} to={s.path} title={s.hint}
              className={({ isActive }) => cn('inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium',
                isActive ? 'bg-brand-700 text-white' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
              <Icon name={s.icon} className="size-3.5" />{s.label}
            </NavLink>
          ))}
        </nav>
      )}
      {ok ? children : <Empty icon="Lock" title="Not available for your role">Ask the administrator if you need this pharmacy screen.</Empty>}
    </div>
  )
}

export const MODES = ['CASH', 'CARD', 'UPI', 'WALLET', 'CHEQUE', 'BANK'] as const
export type PayMode = (typeof MODES)[number]
export const MODE_LABEL: Record<string, string> = { CASH: 'Cash', CARD: 'Card', UPI: 'UPI', WALLET: 'Wallet', CHEQUE: 'Cheque', BANK: 'Bank transfer' }
export const NEEDS_REF = new Set(['CARD', 'UPI', 'WALLET', 'CHEQUE', 'BANK'])
