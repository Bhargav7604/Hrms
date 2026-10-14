/**
 * Dashboard Designer: compose a dashboard from widgets (KPI tile, line / area / bar / donut chart, table)
 * bound to a metric or to any report the role can open (with report filters), arrange them on a 12-column
 * grid (drag, arrows, width / height), save, and share with roles or named users.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, GripVertical, Minus, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Button, Card, cn, Empty, ErrorBox, Input, PageHeader, Select, Spinner, Switch, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import type { ReportMeta } from '@/features/reports/types'
import { useDashParams } from './controls'
import type { WidgetSpec } from './types'
import { useWidgets, WidgetGrid } from './WidgetGrid'

interface Sources {
  metrics: { key: string; label: string; format: string; group: string; point: boolean; series: boolean }[]
  reports: { code: string; name: string; category: string; kind: string }[]
}
const TYPES: { key: WidgetSpec['type']; label: string }[] = [
  { key: 'kpi', label: 'KPI tile' }, { key: 'area', label: 'Area chart' }, { key: 'line', label: 'Line chart' }, { key: 'bar', label: 'Bar chart' },
  { key: 'donut', label: 'Donut' }, { key: 'table', label: 'Table' },
]
const WIDTHS = [2, 3, 4, 6, 8, 12]
const NUM = new Set(['number', 'money', 'percent', 'minutes', 'days'])
const newId = () => Math.random().toString(36).slice(2, 9)

function WidgetForm({ sources, initial, onSave, onCancel }: { sources: Sources; initial?: WidgetSpec; onSave: (w: WidgetSpec) => void; onCancel?: () => void }) {
  const [w, setW] = useState<WidgetSpec>(initial ?? { id: newId(), type: 'kpi', title: '', w: 3, h: 1, source: { kind: 'metric', key: sources.metrics[0]?.key ?? '' } })
  const [rq, setRq] = useState('')
  const src = w.source
  const code = src.kind === 'report' ? src.code : ''
  const meta = useQuery({ queryKey: ['reports', 'meta', code], queryFn: () => api<ReportMeta>(`/reports/${code}`), enabled: !!code, staleTime: 300_000 })
  const reports = useMemo(() => sources.reports.filter((r) => !rq || `${r.code} ${r.name} ${r.category}`.toLowerCase().includes(rq.toLowerCase())).slice(0, 80), [sources, rq])
  const groups = useMemo(() => [...new Set(sources.metrics.map((m) => m.group))], [sources])
  const setSrc = (patch: Record<string, unknown>) => setW({ ...w, source: { ...src, ...patch } as WidgetSpec['source'] })
  const cols = meta.data?.columns ?? []
  const numCols = cols.filter((c) => NUM.has(c.type))
  return (
    <div className="space-y-3">
      <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Widget type</span>
        <Select value={w.type} onChange={(e) => { const t = e.target.value as WidgetSpec['type']; setW({ ...w, type: t, h: t === 'kpi' ? 1 : Math.max(2, w.h), w: t === 'kpi' ? Math.min(w.w, 3) : Math.max(w.w, 4) }) }}>
          {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </Select></label>
      <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
        {(['metric', 'report'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={src.kind === k} onClick={() => setW({ ...w, source: k === 'metric' ? { kind: 'metric', key: sources.metrics[0]?.key ?? '' } : { kind: 'report', code: '', filters: {} } })}
            className={cn('rounded-md px-3 py-1 text-xs font-medium', src.kind === k ? 'bg-surface text-ink shadow-sm' : 'text-ink-2')}>{k === 'metric' ? 'Metric' : 'Report'}</button>
        ))}
      </div>
      {src.kind === 'metric' ? (
        <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Metric</span>
          <Select value={src.key} onChange={(e) => setSrc({ key: e.target.value })}>
            {groups.map((g) => <optgroup key={g} label={g}>{sources.metrics.filter((m) => m.group === g).map((m) => <option key={m.key} value={m.key}>{m.label}{m.point ? ' (now)' : ''}</option>)}</optgroup>)}
          </Select>
          {w.type !== 'kpi' && !sources.metrics.find((m) => m.key === src.key)?.series && <span className="mt-1 block text-[11px] text-amber-700">This metric has no daily series — it renders as a tile.</span>}
        </label>
      ) : (
        <>
          <div><span className="mb-1 block text-xs font-medium text-ink-2">Report</span>
            <Input value={rq} onChange={(e) => setRq(e.target.value)} placeholder="Search reports…" className="mb-1 h-8" />
            <Select value={code} onChange={(e) => setSrc({ code: e.target.value, x: undefined, y: [], columns: [], filters: {} })} size={6} className="h-auto">
              {reports.map((r) => <option key={r.code} value={r.code}>{r.code} · {r.name}</option>)}
            </Select></div>
          {meta.data && (
            <div className="space-y-2 rounded-lg border border-line p-2">
              {w.type !== 'table' && (
                <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">{w.type === 'kpi' ? 'Sum of column (blank = report headline tile)' : 'Category / X column'}</span>
                  {w.type === 'kpi' ? (
                    <Select value={src.y?.[0] ?? ''} onChange={(e) => setSrc({ y: e.target.value ? [e.target.value] : [] })}>
                      <option value="">Headline tile</option>{numCols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </Select>
                  ) : (
                    <Select value={src.x ?? ''} onChange={(e) => setSrc({ x: e.target.value })}>
                      <option value="">Report default</option>{cols.filter((c) => !NUM.has(c.type)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </Select>
                  )}</label>
              )}
              {w.type !== 'kpi' && (
                <div><span className="mb-1 block text-xs font-medium text-ink-2">{w.type === 'table' ? 'Columns' : 'Values (one axis — same unit)'}</span>
                  <div className="flex max-h-32 flex-wrap gap-1 overflow-auto">
                    {(w.type === 'table' ? cols : numCols).map((c) => {
                      const list = (w.type === 'table' ? src.columns : src.y) ?? []
                      const on = list.includes(c.key)
                      return <button key={c.key} type="button" aria-pressed={on} onClick={() => setSrc({ [w.type === 'table' ? 'columns' : 'y']: on ? list.filter((k) => k !== c.key) : [...list, c.key] })}
                        className={cn('rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-brand-700 bg-brand-700 text-white' : 'border-line text-ink-2')}>{c.label}</button>
                    })}
                  </div></div>
              )}
              {w.type !== 'kpi' && <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Rows</span>
                <Input type="number" min={1} max={50} value={src.limit ?? 10} onChange={(e) => setSrc({ limit: Number(e.target.value) })} className="h-8" /></label>}
              {meta.data.filters.filter((f) => f.type !== 'period' && f.type !== 'text').map((f) => (
                <div key={f.key}><span className="mb-1 block text-xs font-medium text-ink-2">{f.label}</span>
                  {f.type === 'ref' && f.ref ? (
                    <div className="flex gap-1">
                      <div className="flex-1"><RefPicker refName={f.ref} filter={f.ref_filter} value={src.filters?.[f.key] === '$me' ? null : src.filters?.[f.key] ?? null}
                        onChange={(id) => setSrc({ filters: { ...src.filters, [f.key]: id ?? '' } })} /></div>
                      {f.key === 'doctor' && <Button size="sm" variant={src.filters?.[f.key] === '$me' ? 'primary' : 'secondary'} onClick={() => setSrc({ filters: { ...src.filters, doctor: src.filters?.doctor === '$me' ? '' : '$me' } })}>Me</Button>}
                    </div>
                  ) : (
                    <Select value={src.filters?.[f.key] ?? ''} onChange={(e) => setSrc({ filters: { ...src.filters, [f.key]: e.target.value } })}>
                      <option value="">{f.placeholder ?? 'All'}</option>{f.options?.map((o) => <option key={o}>{o}</option>)}
                    </Select>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Title</span>
        <Input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} placeholder="Defaults to the metric / report name" /></label>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={src.kind === 'report' ? !code : !src.key}
          onClick={() => { onSave(w); if (!initial) setW({ ...w, id: newId(), title: '' }) }}>{initial ? 'Update widget' : <><Plus className="size-4" /> Add widget</>}</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  )
}

export default function Designer() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const meta = useMeta()
  const sources = useQuery({ queryKey: ['dash', 'sources'], queryFn: () => api<Sources>('/dashboards/sources'), staleTime: 300_000 })
  const existing = useQuery({ queryKey: ['dash', 'board', `c-${id}`], queryFn: () => api<{ name: string; description: string; icon: string; widgets: WidgetSpec[]; visible_to_roles: string[]; shared_with_users: string[]; status: string; can_edit: boolean }>(`/dashboards/c-${id}`), enabled: !!id })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('LayoutDashboard')
  const [widgets, setWidgets] = useState<WidgetSpec[]>([])
  const [roles, setRoles] = useState<string[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [userQ, setUserQ] = useState('')
  const [publish, setPublish] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const { params } = useDashParams('this_month')
  useEffect(() => {
    const d = existing.data
    if (!d) return
    setName(d.name); setDescription(d.description ?? ''); setIcon(d.icon ?? 'LayoutDashboard'); setWidgets(d.widgets ?? [])
    setRoles(d.visible_to_roles ?? []); setUsers(d.shared_with_users ?? []); setPublish(d.status === 'Published')
  }, [existing.data])
  const preview = useWidgets(`designer-${id ?? 'new'}`, widgets, params, false)
  const people = useQuery({ queryKey: ['dash', 'share-users', userQ], queryFn: () => api<{ username: string; name: string; role: string }[]>('/dashboards/share/users', { query: { q: userQ } }), enabled: userQ.length >= 2 })
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, icon, widgets, visible_to_roles: roles, shared_with_users: users, publish }
      return id ? api<{ key: string }>(`/dashboards/custom/${id}`, { method: 'PUT', body }) : api<{ key: string }>('/dashboards/custom', { method: 'POST', body })
    },
    onSuccess: (r) => { toast.success('Dashboard saved'); qc.invalidateQueries({ queryKey: ['dash'] }); nav(`/dashboards/${r.key}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: () => api(`/dashboards/custom/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Dashboard deleted'); qc.invalidateQueries({ queryKey: ['dash'] }); nav('/dashboards/mine') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const move = (from: number, to: number) => {
    if (to < 0 || to >= widgets.length) return
    const arr = [...widgets]; const [x] = arr.splice(from, 1); arr.splice(to, 0, x); setWidgets(arr)
  }
  const patch = (wid: string, p: Partial<WidgetSpec>) => setWidgets(widgets.map((w) => (w.id === wid ? { ...w, ...p } : w)))

  if (sources.isLoading || (id && existing.isLoading)) return <Spinner />
  if (sources.error) return <ErrorBox error={sources.error} />
  if (existing.error) return <ErrorBox error={existing.error} />
  if (existing.data && !existing.data.can_edit) return <Empty icon="Lock" title="Only the owner can edit this dashboard" />
  const src = sources.data!
  if (!src.metrics.length && !src.reports.length) return <Empty icon="Lock" title="Your role has no data to build dashboards from" />

  const toolbar = (w: WidgetSpec, i: number) => (
    <div className="no-print absolute -top-2 right-1 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 shadow-md"
      draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null) }}>
      <GripVertical className="size-3.5 cursor-grab text-ink-3" aria-label="Drag to reorder" />
      <button type="button" onClick={() => move(i, i - 1)} aria-label="Move earlier" className="rounded p-0.5 hover:bg-surface-2"><ArrowLeft className="size-3.5" /></button>
      <button type="button" onClick={() => move(i, i + 1)} aria-label="Move later" className="rounded p-0.5 hover:bg-surface-2"><ArrowRight className="size-3.5" /></button>
      <button type="button" onClick={() => patch(w.id, { w: WIDTHS[Math.max(0, WIDTHS.indexOf(w.w) - 1)] ?? 2 })} aria-label="Narrower" className="rounded p-0.5 hover:bg-surface-2"><Minus className="size-3.5" /></button>
      <span className="px-0.5 text-[10px] tabular-nums text-ink-3">{w.w}/12</span>
      <button type="button" onClick={() => patch(w.id, { w: WIDTHS[Math.min(WIDTHS.length - 1, WIDTHS.indexOf(w.w) + 1)] ?? 12 })} aria-label="Wider" className="rounded p-0.5 hover:bg-surface-2"><Plus className="size-3.5" /></button>
      {w.type !== 'kpi' && <>
        <button type="button" onClick={() => patch(w.id, { h: Math.max(2, w.h - 1) })} aria-label="Shorter" className="rounded p-0.5 hover:bg-surface-2"><ChevronUp className="size-3.5" /></button>
        <button type="button" onClick={() => patch(w.id, { h: Math.min(4, w.h + 1) })} aria-label="Taller" className="rounded p-0.5 hover:bg-surface-2"><ChevronDown className="size-3.5" /></button>
      </>}
      <button type="button" onClick={() => setEditing(w.id)} aria-label="Edit widget" className="rounded p-0.5 hover:bg-surface-2"><Pencil className="size-3.5" /></button>
      <button type="button" onClick={() => setWidgets(widgets.filter((x) => x.id !== w.id))} aria-label="Remove widget" className="rounded p-0.5 text-red-600 hover:bg-surface-2"><Trash2 className="size-3.5" /></button>
    </div>
  )
  const editingW = widgets.find((w) => w.id === editing)

  return (
    <div>
      <PageHeader icon="PencilRuler" title={id ? `Edit dashboard` : 'Dashboard Designer'} subtitle="Build a dashboard from metrics and report widgets, arrange it, then share it with roles or colleagues."
        actions={<>
          <Link to="/dashboards"><Button size="sm"><ArrowLeft className="size-4" /> Dashboards</Button></Link>
          {id && <Button size="sm" variant="danger" onClick={() => remove.mutate()} loading={remove.isPending} icon="Trash2">Delete</Button>}
          <Button size="sm" variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim() || !widgets.length} icon="Save">Save</Button>
        </>} />
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 rounded-xl border border-dashed border-line-2 bg-surface-2/50 p-3">
          {widgets.length ? <WidgetGrid widgets={widgets} data={preview.data?.widgets} compare={preview.data?.compare} edit={toolbar} />
            : <Empty icon="LayoutGrid" title="Add your first widget">Pick a widget type and bind it to a metric or a report on the right.</Empty>}
        </div>
        <div className="space-y-4">
          <Card title={editingW ? 'Edit widget' : 'Add a widget'} icon="SquarePlus">
            {editingW ? <WidgetForm key={editingW.id} sources={src} initial={editingW} onSave={(w) => { setWidgets(widgets.map((x) => (x.id === w.id ? w : x))); setEditing(null) }} onCancel={() => setEditing(null)} />
              : <WidgetForm sources={src} onSave={(w) => setWidgets([...widgets, w])} />}
          </Card>
          <Card title="Details & sharing" icon="Share2">
            <div className="space-y-3">
              <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Name *</span><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cardiology unit review" /></label>
              <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Description</span><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
              <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">Icon (lucide name)</span><Input value={icon} onChange={(e) => setIcon(e.target.value)} /></label>
              <div><span className="mb-1 block text-xs font-medium text-ink-2">Share with roles</span>
                <div className="flex flex-wrap gap-1">{Object.entries(meta.data?.roles ?? {}).filter(([k]) => k !== 'employee').map(([k, l]) => (
                  <button key={k} type="button" aria-pressed={roles.includes(k)} onClick={() => setRoles(roles.includes(k) ? roles.filter((r) => r !== k) : [...roles, k])}
                    className={cn('rounded-full border px-2 py-0.5 text-[11px]', roles.includes(k) ? 'border-brand-700 bg-brand-700 text-white' : 'border-line text-ink-2')}>{l}</button>
                ))}</div></div>
              <div><span className="mb-1 block text-xs font-medium text-ink-2">Share with people</span>
                <div className="mb-1 flex flex-wrap gap-1">{users.map((u) => <span key={u} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{u}
                  <button type="button" onClick={() => setUsers(users.filter((x) => x !== u))} aria-label={`Remove ${u}`}><X className="size-3" /></button></span>)}</div>
                <Input value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Search colleagues…" className="h-8" />
                {people.data && userQ.length >= 2 && (
                  <ul className="mt-1 max-h-36 overflow-auto rounded-lg border border-line">
                    {people.data.filter((p) => !users.includes(p.username)).map((p) => (
                      <li key={p.username}><button type="button" onClick={() => { setUsers([...users, p.username]); setUserQ('') }} className="w-full px-2 py-1 text-left text-xs hover:bg-surface-2">{p.name} <span className="text-ink-3">· {p.role}</span></button></li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-[11px] text-ink-3">People only see widgets their own role may open.</p></div>
              <label className="flex items-center gap-2 text-sm text-ink"><Switch checked={publish} onChange={setPublish} label="Publish" /> Publish (visible to the roles and people above)</label>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
