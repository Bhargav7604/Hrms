import { lazy } from 'react'

export const path = '/op/my-clinic'
export const nav = {
  label: 'My Clinic', icon: 'Stethoscope', module: 'opd', page: 'my-clinic',
  keywords: 'op opd doctor day patients waiting seen emr consult queue', description: 'Your OP day — waiting, with you, seen — and one click into the EMR',
}
export default lazy(() => import('@/features/opd/MyClinic'))
