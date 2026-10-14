import { lazy } from 'react'

export const path = '/er/tracking'
export const nav = { label: 'ER tracking board', icon: 'ClipboardList', module: 'er', page: 'er-tracking', keywords: 'emergency casualty worklist' }
export default lazy(() => import('@/features/er/TrackingBoard'))
