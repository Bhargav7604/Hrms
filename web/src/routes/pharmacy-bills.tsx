import { lazy } from 'react'

export const path = '/pharmacy/bills'
export const nav = { label: 'Pharmacy bills report', icon: 'ReceiptText', group: 'Pharmacy / e-Rx', roles: ['pharmacist', 'management'], keywords: 'op pharmacy bills drafts cancelled gst' }
export default lazy(() => import('@/features/pharmacy/Bills'))
