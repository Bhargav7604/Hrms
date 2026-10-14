import { lazy } from 'react'

export const path = '/pharmacy/counter'
export const nav = { label: 'Pharmacy billing', icon: 'ShoppingCart', module: 'pharmacy', page: 'op-pharmacy', keywords: 'op pharmacy counter sale bill otc new bill medicine' }
export default lazy(() => import('@/features/pharmacy/Counter'))
