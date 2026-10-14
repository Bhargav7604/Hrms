import { lazy } from 'react'

export const path = '/ip/on-bed'
export const nav = { label: 'On bed', icon: 'Bed', module: 'ipd', keywords: 'census occupied beds inpatients balance collected ipd', description: 'Every occupied bed with stay, acuity and money' }
export default lazy(() => import('@/features/ipd/OnBed'))
