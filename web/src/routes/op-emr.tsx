import { lazy } from 'react'

export const path = '/op/emr/:encounterId'
export default lazy(() => import('@/features/opd/OpEmr'))
