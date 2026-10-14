import { lazy } from 'react'

export const path = '/reports'
export const nav = {
  label: 'Reports Hub', icon: 'FileBarChart', group: 'Reports & analytics',
  roles: ['admin', 'management', 'doctor', 'nurse', 'front_office', 'billing', 'pharmacist', 'lab', 'radiology', 'hr', 'stores', 'quality', 'support', 'marketing'],
  keywords: 'reports mis collection revenue gst register export schedule nabh statutory', description: 'MIS reports and a register for every record type',
}
export default lazy(() => import('@/features/reports/Hub'))
