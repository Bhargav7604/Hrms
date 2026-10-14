import { lazy } from 'react'

export const path = '/dialysis/desk'
export const nav = {
  label: 'Dialysis', icon: 'Droplets', module: 'dialysis', page: 'dialysis-desk',
  keywords: 'dialysis haemodialysis hd renal session machine check in check out', description: 'Billed patient → check-in → session → check-out',
}
export default lazy(() => import('@/features/dialysis/DialysisDesk'))
