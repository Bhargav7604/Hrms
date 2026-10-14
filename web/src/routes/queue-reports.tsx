import { lazy } from 'react'

export const path = '/queue/reports'
export const nav = {
  label: 'Token Reports', icon: 'ChartColumn', module: 'queue', page: 'token-reports',
  keywords: 'op queue tokens wait time p90 hourly volumes analytics', description: 'Volumes and waits by hour, day and queue',
}
export default lazy(() => import('@/features/queue/TokenReports'))
