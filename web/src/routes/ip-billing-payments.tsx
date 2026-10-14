import { lazy } from 'react'

export const path = '/ip/billing/payments'
export const nav = { label: 'IP payment desk', icon: 'Wallet', module: 'billing', page: 'payment-desk', keywords: 'advance deposit receipt refund collection inpatient payment desk', description: 'Advances and receipts across admissions' }
export default lazy(() => import('@/features/ipbilling/PaymentDesk'))
