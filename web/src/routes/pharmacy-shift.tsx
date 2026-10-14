import { lazy } from 'react'

export const path = '/pharmacy/shift'
export const nav = { label: 'Pharmacy shift summary', icon: 'Clock', group: 'Pharmacy / e-Rx', roles: ['pharmacist', 'management'], keywords: 'op pharmacy shift open close cash count' }
export default lazy(() => import('@/features/pharmacy/Shift'))
