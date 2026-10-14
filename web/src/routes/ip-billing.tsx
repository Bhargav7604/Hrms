import { lazy } from 'react'

export const path = '/ip/billing'
export const nav = { label: 'IP Approximate Bill', icon: 'FileSpreadsheet', module: 'billing', page: 'ip-billing', keywords: 'ip billing working bill approximate estimate package sponsor inpatient', description: 'Live working bill per admission' }
export default lazy(() => import('@/features/ipbilling/BillList'))
