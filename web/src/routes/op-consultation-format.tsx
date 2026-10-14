import { lazy } from 'react'

export const path = '/op/consultation-format'
export const nav = { label: 'My consultation format', icon: 'SlidersHorizontal', module: 'opd', page: 'consultation-format', keywords: 'emr layout fields' }
export default lazy(() => import('@/features/opd/ConsultationFormat'))
