import { lazy } from 'react'

export const path = '/er/visits/:id/print'
export const shell = false
export default lazy(() => import('@/features/er/PrintSheet'))
