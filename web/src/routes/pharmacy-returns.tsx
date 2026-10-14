import { lazy } from 'react'

export const path = '/pharmacy/returns'
export const nav = { label: 'Pharmacy returns', icon: 'Undo2', group: 'Pharmacy / e-Rx', roles: ['pharmacist', 'management'], keywords: 'op pharmacy return approval refund' }
export default lazy(() => import('@/features/pharmacy/Returns'))
