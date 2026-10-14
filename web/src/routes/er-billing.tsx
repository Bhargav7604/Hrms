import { lazy } from 'react'

export const path = '/er/billing'
export const nav = { label: 'ER billing', icon: 'IndianRupee', module: 'er', page: 'er-billing', keywords: 'emergency bill closure' }
export default lazy(() => import('@/features/er/BillingDesk'))
