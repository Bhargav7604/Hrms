import { lazy } from 'react'

export const path = '/dashboards/designer/:id'
export default lazy(() => import('@/features/dashboards/Designer'))
