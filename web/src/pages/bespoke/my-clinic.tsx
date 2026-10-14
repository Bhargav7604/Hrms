import { lazy, Suspense } from 'react'
import { Spinner } from '@/components/ui'
import type { BespokeProps } from './index'

const MyClinic = lazy(() => import('@/features/opd/MyClinic'))

/** OPD workspace tab: the doctor's day view (full screen at /op/my-clinic). */
export default function MyClinicTab(_: BespokeProps) {
  return <Suspense fallback={<Spinner />}><MyClinic embedded /></Suspense>
}
