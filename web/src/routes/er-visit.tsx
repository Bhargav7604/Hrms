import { lazy } from 'react'

export const path = '/er/visits/:id'
export default lazy(() => import('@/features/er/VisitChart'))
