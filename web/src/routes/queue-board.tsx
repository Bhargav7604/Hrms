import { lazy } from 'react'

/** Public TV board for a configured display board (Queue Management › Display Boards). */
export const path = '/queue/board/:code'
export const shell = false
export const auth = false
export default lazy(() => import('@/features/queue/DisplayBoardScreen'))
