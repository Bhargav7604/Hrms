import { lazy } from 'react'

export const path = '/ip/admissions/new'
export const nav = { label: 'New admission', icon: 'UserPlus', group: 'IPD / ADT / Bed Management', roles: ['front_office', 'nurse', 'doctor'], keywords: 'admit inpatient ipd bed sponsor', description: 'Admit a registered patient' }
export default lazy(() => import('@/features/ipd/NewAdmission'))
