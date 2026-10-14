import { lazy } from 'react'

export const path = '/support'
export default lazy(() => import('@/features/platform/Support'))
