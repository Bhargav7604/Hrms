import { lazy, Suspense } from 'react'
import { Spinner } from '@/components/ui'
import type { BespokeProps } from './index'

const DialysisDesk = lazy(() => import('@/features/dialysis/DialysisDesk'))

/** Dialysis workspace tab: billed patient → check-in → session → check-out (full screen at /dialysis/desk). */
export default function DialysisDeskTab(_: BespokeProps) {
  return <Suspense fallback={<Spinner />}><DialysisDesk embedded /></Suspense>
}
