import { lazy } from 'react'

/** Discharge desk. `?admission=<id>` opens the discharge wizard for that admission (IP chart / tracker link). */
export const path = '/ip/billing/discharge'
export const nav = { label: 'Discharge desk', icon: 'DoorOpen', module: 'billing', page: 'discharge-desk', keywords: 'discharge patient settle bill release bed check-out slip case sheet', description: 'Settle the bill, discharge details, release the bed' }
export default lazy(() => import('@/features/ipbilling/DischargeDesk'))
