import { lazy } from 'react'

export const path = '/queue/register'
export const nav = {
  label: 'Token Register', icon: 'ClipboardList', module: 'queue', page: 'token-register',
  keywords: 'op queue tokens list export csv uhid', description: 'Every token issued, with waits',
}
export default lazy(() => import('@/features/queue/TokenRegister'))
