import { lazy } from 'react'

export const path = '/account/sessions'
export default lazy(() => import('@/features/platform/Sessions'))
