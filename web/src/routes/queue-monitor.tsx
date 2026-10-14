import { lazy } from 'react'

export const path = '/queue/monitor'
export const nav = {
  label: 'Queue Monitor', icon: 'Gauge', module: 'queue', page: 'queue-monitor',
  keywords: 'op queue tokens live waiting longest wait capacity lines', description: 'Every token line live, side by side',
}
export default lazy(() => import('@/features/queue/QueueMonitor'))
