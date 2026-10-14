import { lazy } from 'react'

export const path = '/admin/config'
export default lazy(() => import('@/features/platform/FieldConfig'))
