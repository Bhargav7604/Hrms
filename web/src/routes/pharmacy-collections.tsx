import { lazy } from 'react'

export const path = '/pharmacy/collections'
export const nav = { label: 'Pharmacy user collection', icon: 'Wallet', group: 'Pharmacy / e-Rx', roles: ['pharmacist', 'management'], keywords: 'op pharmacy collection report cashier' }
export default lazy(() => import('@/features/pharmacy/Reports').then((m) => ({ default: m.UserCollections })))
