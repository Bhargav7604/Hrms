import { lazy } from 'react'

export const path = '/lab/outsourcing'
export const nav = { label: 'Lab out-sourcing', icon: 'Truck', module: 'lab', page: 'lab-worklist', keywords: 'reference lab send out dispatch' }
export default lazy(() => import('@/features/lab/Outsourcing'))
