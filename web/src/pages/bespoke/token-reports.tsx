import { Empty, Spinner } from '@/components/ui'
import { useQueueAccess } from '@/features/queue/access'
import { TokenReports } from '@/features/queue/TokenReports'
import type { BespokeProps } from './index'

/** Queue Management › Token Reports (full page at /queue/reports). */
export default function TokenReportsTab(_: BespokeProps) {
  const access = useQueueAccess()
  if (!access.ready) return <Spinner />
  if (!access.reports) return <Empty icon="Lock" title="Token reports need access to queue tokens" />
  return <TokenReports />
}
