import { lazy } from 'react'

export const path = '/admin/roles'
export default lazy(() => import('@/features/platform/RolesPermissions'))
