import { Empty, Spinner } from '@/components/ui'
import { useQueueAccess } from '@/features/queue/access'
import { TokenRegister } from '@/features/queue/TokenRegister'
import type { BespokeProps } from './index'

/** Queue Management › Token Register (full page at /queue/register). */
export default function TokenRegisterTab(_: BespokeProps) {
  const access = useQueueAccess()
  if (!access.ready) return <Spinner />
  if (!access.register) return <Empty icon="Lock" title="The token register needs access to queue tokens" />
  return <TokenRegister />
}
