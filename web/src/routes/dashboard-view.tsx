import { lazy } from 'react'

export const path = '/dashboards/:key'
export default lazy(() => import('@/features/dashboards/DashboardView'))
