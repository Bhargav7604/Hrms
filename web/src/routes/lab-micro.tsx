import { lazy } from 'react'

export const path = '/lab/micro'
export const nav = { label: 'Microbiology', icon: 'Microscope', module: 'lab', page: 'lab-worklist', keywords: 'culture sensitivity organism antibiotic' }
export default lazy(() => import('@/features/lab/Micro'))
