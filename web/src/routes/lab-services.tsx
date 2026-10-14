import { lazy } from 'react'

export const path = '/lab/services'
export const nav = { label: 'All lab services', icon: 'BookOpen', module: 'lab', keywords: 'lab test catalogue tat rate sample container method' }
export default lazy(() => import('@/features/lab/Services'))
