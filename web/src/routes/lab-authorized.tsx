import { lazy } from 'react'

export const path = '/lab/authorized'
export const nav = { label: 'Authorised reports', icon: 'FileCheck2', module: 'lab', group: 'Laboratory (LIS)', keywords: 'lab reports print smart report rollback released results' }
export default lazy(() => import('@/features/lab/Authorized'))
