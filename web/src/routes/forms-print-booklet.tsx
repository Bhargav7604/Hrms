import { lazy } from 'react'

export const path = '/print/ot-booklet'
export const shell = false
export default lazy(() => import('@/features/forms/print').then((m) => ({ default: m.BookletPrint })))
