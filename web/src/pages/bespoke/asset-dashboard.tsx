import { lazy, Suspense } from 'react'
import { Navigate } from 'react-router'
import { Spinner } from '@/components/ui'
import { useAssetAccess } from '@/features/assets/parts'
import type { BespokeProps } from './index'

const AssetDashboard = lazy(() => import('@/features/assets/AssetDashboard'))

/** Assets module workspace tab: the asset dashboard, embedded (full screen at /assets/dashboard). */
export default function AssetDashboardTab({ module }: BespokeProps) {
  const access = useAssetAccess()
  if (!access.ready) return <Spinner />
  if (!access.dashboard) {
    // Roles that only read part of the module (e.g. quality, or clinicians raising breakdown tickets) land on their first record tab.
    const first = module.entities.find((e) => module.access.entities[e.key]?.read)
    return first ? <Navigate to={`/m/${module.id}/${first.key}`} replace /> : null
  }
  return (
    <Suspense fallback={<Spinner />}>
      <AssetDashboard embedded />
    </Suspense>
  )
}
