import { lazy } from 'react'

export const path = '/er/register'
export const nav = { label: 'ER registration', icon: 'UserPlus', module: 'er', page: 'er-register', keywords: 'emergency casualty enrol unknown' }
export default lazy(() => import('@/features/er/Register'))
