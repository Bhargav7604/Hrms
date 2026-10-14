import { useEffect } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/ui'
import AssetDashboard from './AssetDashboard'
import { useAssetAccess } from './parts'

/** Full-page asset dashboard at /assets/dashboard (the same screen is embedded in the Assets module). */
export default function AssetDashboardPage() {
  const access = useAssetAccess()
  useEffect(() => {
    const prev = document.title
    document.title = 'Asset dashboard · Vlack HRMS'
    return () => { document.title = prev }
  }, [])
  return (
    <div>
      <div className="no-print">
        <PageHeader icon="Wrench" title="Asset dashboard"
          subtitle="Register, due dates, maintenance, compliance and book value of biomedical and facility assets."
          actions={access.canRead('assets.assets') ? (
            <Link to="/m/assets/assets" className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-brand-700 hover:bg-surface-2 dark:text-brand-300">Asset register →</Link>
          ) : undefined} />
      </div>
      <AssetDashboard />
    </div>
  )
}
