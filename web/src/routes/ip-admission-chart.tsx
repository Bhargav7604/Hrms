import { lazy } from 'react'

export const path = '/ip/admissions/:id'
export default lazy(() => import('@/features/ipd/chart/AdmissionChart'))
