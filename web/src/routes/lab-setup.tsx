import { lazy } from 'react'

export const path = '/lab/setup'
export const nav = { label: 'Lab setup', icon: 'Settings2', module: 'lab', page: 'lab-worklist', keywords: 'reference range reflex delta analyser report format antibiotic' }
export default lazy(() => import('@/features/lab/Setup'))
