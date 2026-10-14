import { lazy } from 'react'

export const path = '/lab/accept'
export const nav = { label: 'Accept samples', icon: 'PackageCheck', module: 'lab', page: 'lab-worklist', keywords: 'lab receive scan reject sample' }
export default lazy(() => import('@/features/lab/Accept'))
