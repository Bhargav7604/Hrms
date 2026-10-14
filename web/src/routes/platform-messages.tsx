import { lazy } from 'react'

export const path = '/messages'
export default lazy(() => import('@/features/platform/Messages'))
