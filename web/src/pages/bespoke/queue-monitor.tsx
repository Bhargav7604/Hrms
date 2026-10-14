import { Empty, Spinner } from '@/components/ui'
import { useQueueAccess } from '@/features/queue/access'
import { QueueMonitor } from '@/features/queue/QueueMonitor'
import type { BespokeProps } from './index'

/** Queue Management › Queue Monitor (full page at /queue/monitor). */
export default function QueueMonitorTab(_: BespokeProps) {
  const access = useQueueAccess()
  if (!access.ready) return <Spinner />
  if (!access.monitor) return <Empty icon="Lock" title="The Queue Monitor needs access to queue tokens" />
  return <QueueMonitor />
}
