import { lazy } from 'react'

export const path = '/ip/admissions/:id/print/:doc'
export const shell = false
export default lazy(() => import('@/features/ipd/PrintDoc'))
