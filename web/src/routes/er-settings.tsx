import { lazy } from 'react'

export const path = '/er/settings'
export const nav = { label: 'ER settings', icon: 'Settings2', roles: ['admin'], keywords: 'emergency triage targets configuration' }
export default lazy(() => import('@/features/er/Settings'))
