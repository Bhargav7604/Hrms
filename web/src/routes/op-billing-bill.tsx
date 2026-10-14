import { lazy } from 'react'

export const path = '/op/billing/:billId'
export default lazy(() => import('@/features/opbilling/BillingCounter'))
