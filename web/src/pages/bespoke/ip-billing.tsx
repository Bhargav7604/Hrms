import BillList from '@/features/ipbilling/BillList'
import type { BespokeProps } from './index'

/** Billing module page — the same screen as the full-page route, inside the module workspace. */
export default function Page(_: BespokeProps) {
  return <BillList embedded />
}
