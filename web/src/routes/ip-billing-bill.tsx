import { lazy } from 'react'

export const path = '/ip/billing/:admissionId'
export default lazy(() => import('@/features/ipbilling/WorkingBill'))
