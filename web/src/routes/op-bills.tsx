import { lazy } from 'react'

export const path = '/op/bills'
export const nav = { label: 'OP bills', icon: 'FileText', module: 'appointments', page: 'op-bills', keywords: 'register refunds receipts payment mode correction' }
export default lazy(() => import('@/features/opbilling/BillsRegister'))
