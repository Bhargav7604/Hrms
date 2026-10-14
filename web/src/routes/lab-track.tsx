import { lazy } from 'react'

export const path = '/lab/track'
export const nav = { label: 'Track samples', icon: 'Route', module: 'lab', keywords: 'lab barcode chain of custody where is sample' }
export default lazy(() => import('@/features/lab/Track'))
