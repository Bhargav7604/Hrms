import { lazy } from 'react'

export const path = '/dashboards'
export const nav = {
  label: 'Dashboards', icon: 'LayoutDashboard', group: 'Reports & analytics',
  roles: ['admin', 'management', 'doctor', 'nurse', 'front_office', 'billing', 'pharmacist', 'lab', 'radiology', 'hr', 'stores', 'quality', 'support', 'marketing'],
  keywords: 'dashboard catalogue analytics management revenue quality nabh lab pharmacy designer', description: 'Every dashboard open to your role',
}
export default lazy(() => import('@/features/dashboards/Catalogue'))
