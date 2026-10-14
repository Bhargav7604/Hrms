import { lazy } from 'react'

export const path = '/dashboards/designer'
export const nav = {
  label: 'Dashboard Designer', icon: 'PencilRuler', group: 'Reports & analytics',
  roles: ['admin', 'management', 'doctor', 'nurse', 'front_office', 'billing', 'pharmacist', 'lab', 'radiology', 'hr', 'stores', 'quality', 'support', 'marketing'],
  keywords: 'build custom dashboard widgets share', description: 'Build a dashboard from report widgets and share it',
}
export default lazy(() => import('@/features/dashboards/Designer'))
