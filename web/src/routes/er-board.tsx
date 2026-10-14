import { lazy } from 'react'

export const path = '/er/board'
export const nav = { label: 'ER ward board', icon: 'Siren', module: 'er', page: 'er-board', keywords: 'emergency casualty beds' }
export default lazy(() => import('@/features/er/WardBoard'))
