import { lazy } from 'react'

export const path = '/lab/results'
export const nav = { label: 'Result entry & verify', icon: 'ClipboardPen', module: 'lab', page: 'lab-worklist', keywords: 'lab worksheet analyser delta reflex authorise' }
export default lazy(() => import('@/features/lab/Worksheet'))
