import { lazy } from 'react'

export const path = '/ip/admissions'
export const nav = { label: 'Admissions (IP)', icon: 'BedDouble', module: 'ipd', keywords: 'inpatient admission list ipd admit accept ward', description: 'Admit, track and discharge in-patients' }
export default lazy(() => import('@/features/ipd/AdmissionsList'))
