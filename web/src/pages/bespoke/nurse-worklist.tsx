import { lazy, Suspense } from 'react'
import { Spinner } from '@/components/ui'
import type { BespokeProps } from './index'

const NurseWorklist = lazy(() => import('@/features/opd/NurseWorklist'))

/** OPD workspace tab: the OP nurse worklist (full screen at /op/nurse-worklist). */
export default function NurseWorklistTab(_: BespokeProps) {
  return <Suspense fallback={<Spinner />}><NurseWorklist embedded /></Suspense>
}
