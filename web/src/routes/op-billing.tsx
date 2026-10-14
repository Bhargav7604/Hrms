import { lazy } from 'react'

export const path = '/op/billing'
export const nav = { label: 'OP / IP billing counter', icon: 'Receipt', module: 'appointments', page: 'op-billing', keywords: 'generate op bill counter cash payment' }
export default lazy(() => import('@/features/opbilling/BillingCounter'))
