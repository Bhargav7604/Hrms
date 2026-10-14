import { lazy } from 'react'

export const path = '/ip/clearances'
export const nav = { label: 'Discharge clearances', icon: 'ClipboardCheck', group: 'IPD / ADT / Bed Management', roles: ['pharmacist', 'lab', 'radiology', 'billing', 'nurse', 'support', 'front_office', 'quality'], keywords: 'discharge clearance department sign off pharmacy lab radiology billing', description: 'Departmental discharge sign-offs waiting for your team' }
export default lazy(() => import('@/features/ipd/Clearances'))
