import { lazy } from 'react'

export const path = '/print/forms/:id'
export const shell = false
export default lazy(() => import('@/features/forms/print').then((m) => ({ default: m.EntryPrint })))
