import { lazy } from 'react'

export const path = '/queue/issue'
export const shell = false
export const nav = {
  label: 'Issue token', icon: 'Ticket', module: 'queue', page: 'queue-console',
  keywords: 'op queue token kiosk walk-in generate', description: 'Full-screen token kiosk',
}
export default lazy(() => import('@/features/queue/IssueToken'))
