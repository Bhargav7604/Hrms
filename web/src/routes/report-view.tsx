import { lazy } from 'react'

export const path = '/reports/:code'
export default lazy(() => import('@/features/reports/Viewer'))
