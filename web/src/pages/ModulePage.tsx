import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Eye, Lock } from 'lucide-react'
import { Suspense, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { EntityView } from '@/components/records'
import { Badge, Card, Empty, PageHeader, Spinner, StatTile, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { kpiValue } from '@/lib/format'
import type { ModuleDef, ModuleStats } from '@/lib/types'
import { BESPOKE } from './bespoke'

export function ModuleKpis({ module }: { module: ModuleDef }) {
  const q = useQuery({ queryKey: ['stats', module.id], queryFn: () => api<ModuleStats>(`/m/${module.id}/stats`), staleTime: 30_000 })
  if (!q.data?.kpis.length) return null
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {q.data.kpis.map((k) => <StatTile key={k.label} label={k.label} value={kpiValue(k.value, k.format)} />)}
    </div>
  )
}

export default function ModulePage() {
  const { moduleId = '', tab } = useParams()
  const reg = useRegistry()
  const nav = useNavigate()
  const [about, setAbout] = useState(false)
  const mod = reg.module(moduleId)
  if (!reg.meta) return <Spinner />
  if (!mod) return <Empty icon="ShieldOff" title="Module not available">This module does not exist or your role cannot open it.</Empty>

  const pages = mod.pages.filter((p) => mod.access.pages.includes(p.key))
  const ents = mod.entities.filter((e) => mod.access.entities[e.key]?.read)
  const tabs = [
    ...pages.map((p) => ({ key: p.key, label: p.label, icon: p.icon ?? 'Sparkles' })),
    ...ents.map((e) => ({ key: e.key, label: <span className="inline-flex items-center gap-1">{e.label}{e.restricted && <Lock className="size-3 text-red-500" />}</span>, icon: undefined })),
  ]
  const active = tab ?? tabs[0]?.key
  if (!tab && active) return <Navigate to={`/m/${mod.id}/${active}`} replace />
  const page = pages.find((p) => p.key === active)
  const ent = ents.find((e) => e.key === active)
  const Bespoke = page ? BESPOKE[page.key] : undefined
  const suite = reg.meta.suites.find((s) => s.id === mod.suite)

  return (
    <div>
      <PageHeader
        icon={mod.icon}
        title={mod.name}
        badge={<>
          <Badge tone="cyan">Module {mod.no}</Badge>
          {!mod.access.write && !(page && mod.access.page_levels?.[page.key] === 'edit') && <Badge tone="gray"><Eye className="size-3" /> View only</Badge>}
        </>}
        subtitle={<>{mod.summary} <span className="text-ink-3">· {suite?.name}</span></>}
        guide={() => setAbout(!about)}
        actions={
          <button onClick={() => setAbout(!about)} className="hidden items-center gap-1 text-sm text-ink-2 hover:text-ink md:inline-flex">
            What this module covers <ChevronDown className={`size-4 transition-transform ${about ? 'rotate-180' : ''}`} />
          </button>
        }
      />
      {about && (
        <Card className="mb-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Features (from the proposal)</h4>
              <ul className="space-y-1 text-sm text-ink">{mod.features.map((f) => <li key={f} className="flex gap-2"><span className="text-brand-700">✓</span>{f}</li>)}</ul>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Records</h4>
                <div className="flex flex-wrap gap-1.5">{mod.entities.map((e) => <Badge key={e.key} tone="gray">{e.label} · {e.fields.length} fields</Badge>)}</div>
              </div>
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Your access</h4>
                <p className="text-ink-2">
                  {pages.length} workspace{pages.length === 1 ? '' : 's'} · {ents.filter((e) => mod.access.entities[e.key]?.write).length} record types you can edit ·{' '}
                  {ents.filter((e) => !mod.access.entities[e.key]?.write).length} view-only. Set per role in Roles & permissions.
                </p>
              </div>
            </div>
          </div>
        </Card>
      )}
      <ModuleKpis module={mod} />
      {tabs.length > 1 && <Tabs className="mb-4" tabs={tabs} value={active ?? ''} onChange={(k) => nav(`/m/${mod.id}/${k}`)} />}
      {page && mod.access.page_levels?.[page.key] === 'view' && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <Eye className="size-4" /> View-only access to this workspace — actions are disabled for your role.
        </div>
      )}
      {page && (Bespoke ? (
        <Suspense fallback={<Spinner />}><Bespoke module={mod} /></Suspense>
      ) : (
        <Empty icon="Construction" title={`${page.label} view`}>This workspace has no custom screen yet. Use the record tabs.</Empty>
      ))}
      {ent && <EntityView key={ent.fqn} entity={ent} />}
      {!page && !ent && <Empty icon="Lock" title="Nothing to show">Your role has no access to this tab.</Empty>}
    </div>
  )
}
