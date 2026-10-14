import { lazy } from 'react'

/** Public department screen: the department's doctors consulting today (by department code or id). */
export const path = '/queue/department/:dept'
export const shell = false
export const auth = false
export default lazy(() => import('@/features/queue/DepartmentScreen'))
