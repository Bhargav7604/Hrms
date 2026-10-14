import { lazy } from 'react'

export const path = '/registration/new'
export const nav = { label: 'Register patient', icon: 'UserPlus', module: 'registration', page: 'patient-registration', keywords: 'new patient uhid aadhaar' }
export default lazy(() => import('@/features/registration/RegisterPatient'))
