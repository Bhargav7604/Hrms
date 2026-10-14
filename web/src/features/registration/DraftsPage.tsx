import { useNavigate } from 'react-router'
import { PageHeader } from '@/components/ui'
import { useRegistry } from '@/lib/auth'
import { DraftList } from './Lists'

/** /registration/drafts — every registration saved part-way; Resume opens it in Register Patient. */
export default function DraftsPage() {
  const reg = useRegistry()
  const nav = useNavigate()
  const canWrite = reg.canEntity('registration.patients', 'write')
  return (
    <div>
      <PageHeader icon="FilePen" title="Draft registrations" subtitle="Registrations saved part-way at the desk. Resume one to finish it, or discard it." />
      <div className="rounded-xl border border-line bg-surface p-4">
        <DraftList canWrite={canWrite} onResume={(id) => nav(`/registration/new?draft=${id}`)} />
      </div>
    </div>
  )
}
