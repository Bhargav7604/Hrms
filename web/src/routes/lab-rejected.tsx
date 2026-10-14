import { lazy } from 'react'

export const path = '/lab/rejected'
export const nav = { label: 'Rejected lab reports', icon: 'FileX2', module: 'lab', keywords: 'lab rejected sample rerun cancelled rollback' }
export default lazy(() => import('@/features/lab/Rejected'))
