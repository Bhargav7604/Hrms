import { lazy } from 'react'

export const path = '/pharmacy/dues'
export const nav = { label: 'Pharmacy due bills', icon: 'HandCoins', group: 'Pharmacy / e-Rx', roles: ['pharmacist', 'management'], keywords: 'op pharmacy due report credit outstanding' }
export default lazy(() => import('@/features/pharmacy/Reports').then((m) => ({ default: m.DueBills })))
