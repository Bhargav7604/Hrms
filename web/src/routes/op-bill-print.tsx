import { lazy } from 'react'

export const path = '/op/bills/:id/print'
export const shell = false
export default lazy(() => import('@/features/opbilling/BillPrint'))
