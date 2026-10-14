import { lazy } from 'react'

export const path = '/lab/cancellation'
export const nav = { label: 'Result cancellation', icon: 'Ban', module: 'lab', page: 'lab-worklist', keywords: 'lab cancel withdraw result' }
export default lazy(() => import('@/features/lab/Cancellation'))
