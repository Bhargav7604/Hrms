import { lazy } from 'react'

export const path = '/print/io-chart'
export const shell = false
export default lazy(() => import('@/features/forms/print').then((m) => ({ default: m.IoChartPrint })))
