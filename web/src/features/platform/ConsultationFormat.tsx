import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Info, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, Input, PageHeader, Spinner, Switch, Tabs } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useAuth, useRegistry } from '@/lib/auth'
import type { FieldRow, FormDef } from './FieldConfig'

const SCREENS = [
  { key: 'op.clinical_note', label: 'OP Clinical Note', icon: 'NotebookPen' },
  { key: 'op.vitals', label: 'OP Vitals', icon: 'Activity' },
  { key: 'op.prescription', label: 'OP Prescription', icon: 'Pill' },
] as const

/**
 * My Consultation Format — a doctor arranges their own OP screens: show/hide, rename and reorder fields.
 * Stored as the "doctor" level of Field Configuration, so it changes only what this doctor sees.
 * Administrators can arrange it for any doctor ("Arranging for").
 */
export default function ConsultationFormat({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth()
  const reg = useRegistry()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'admin'
  const mine = user?.employee_id && reg.canPage('opd', 'consultation-format') ? user.employee_id : null
  const [doctor, setDoctor] = useState<string | null>(mine)
  const [screen, setScreen] = useState<(typeof SCREENS)[number]['key']>('op.clinical_note')
  useEffect(() => { if (!doctor && mine) setDoctor(mine) }, [mine, doctor])
  const preview = !doctor
  const q = useQuery({
    queryKey: ['fieldconfig', 'form', screen, preview ? 'branch' : 'doctor', doctor],
    queryFn: () => api<FormDef>(`/fieldconfig/forms/${screen}`, { query: preview ? { scope: 'branch' } : { scope: 'doctor', scope_id: doctor! } }),
    placeholderData: (p) => p,
  })
  const save = useMutation({
    mutationFn: (fields: Record<string, { visible?: boolean; label?: string | null; order?: number } | null>) =>
      api<FormDef>(`/fieldconfig/forms/${screen}`, { method: 'PUT', body: { scope: 'doctor', scope_id: doctor, fields } }),
    onSuccess: (d) => qc.setQueryData(['fieldconfig', 'form', screen, 'doctor', doctor], d),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const resetSection = useMutation({
    mutationFn: (section: string) => api<FormDef>(`/fieldconfig/forms/${screen}`, { method: 'DELETE', query: { scope: 'doctor', scope_id: doctor!, section } }),
    onSuccess: (d) => { qc.setQueryData(['fieldconfig', 'form', screen, 'doctor', doctor], d); toast.success('Section reset to the standard format') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const d = q.data
  const editable = !preview && !!d?.can_edit

  return (
    <div className="max-w-4xl">
      {embedded ? (
        <p className="mb-3 text-sm text-ink-2">Arrange your own consultation screen — hide, rename and reorder fields. Only what <b>you</b> see changes.</p>
      ) : <PageHeader icon="Stethoscope" title="My Consultation Format"
        subtitle={<>Arrange your own consultation screen — hide the fields you never fill, rename the ones you call something else, and put the ones you use first at the top. This changes what <b>you</b> see; your department&apos;s format and every colleague&apos;s are untouched.</>} />}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-2">Arranging for</span>
        {isAdmin ? (
          <div className="w-72"><RefPicker refName="employees.employees" filter={{ category: 'Doctor' }} value={doctor} placeholder="Choose a doctor…" onChange={(id) => setDoctor(id)} /></div>
        ) : (
          <Badge tone="cyan">{mine ? 'Myself' : 'Standard format (preview)'}</Badge>
        )}
      </div>
      <Tabs className="mb-3" value={screen} onChange={setScreen} tabs={SCREENS.map((s) => ({ key: s.key, label: s.label, icon: s.icon }))} />
      {preview && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span><b>Read-only preview.</b> This login is not linked to a doctor, so it has no format of its own — you are seeing the standard one.
            {isAdmin ? ' Pick a doctor in Arranging for above, or use Field Configuration to change a whole department.' : ''}</span>
        </div>
      )}
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Spinner />}
      {d && d.sections.map((s) => (
        <Section key={`${screen}-${s.key}`} title={s.label} fields={s.fields} editable={editable} busy={save.isPending}
          onSave={(fields) => save.mutate(fields)} onReset={() => { if (confirm(`Reset "${s.label}" to the standard format?`)) resetSection.mutate(s.key) }} />
      ))}
      {d && d.sections.length === 0 && <Empty icon="LayoutList" title="Nothing to arrange on this screen" />}
    </div>
  )
}

function Section({ title, fields, editable, busy, onSave, onReset }: {
  title: string; fields: FieldRow[]; editable: boolean; busy: boolean
  onSave: (f: Record<string, { visible?: boolean; label?: string | null; order?: number } | null>) => void; onReset: () => void
}) {
  // the server returns fields ordered by the effective order
  const [order, setOrder] = useState(fields.map((f) => f.key))
  const [drag, setDrag] = useState<string | null>(null)
  useEffect(() => { setOrder(fields.map((f) => f.key)) }, [fields])
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const shown = fields.filter((f) => f.effective.visible).length
  const commitOrder = (next: string[]) => {
    setOrder(next)
    onSave(Object.fromEntries(next.map((k, i) => [k, { order: i }])))
  }
  const move = (k: string, d: number) => {
    const i = order.indexOf(k)
    const j = i + d
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    commitOrder(next)
  }
  return (
    <Card className="mb-3" title={<span className="flex items-center gap-2">{title} <span className="text-xs font-normal text-ink-3">{shown} of {fields.length} shown</span></span>}
      actions={editable ? <Button size="xs" variant="ghost" onClick={onReset}><RotateCcw className="size-3.5" /> Reset this section</Button> : undefined} pad={false}>
      {order.map((k, i) => {
        const f = byKey.get(k)
        if (!f) return null
        return (
          <Row key={k} f={f} index={i} last={i === order.length - 1} editable={editable} busy={busy} dragging={drag === k}
            onDragStart={() => setDrag(k)} onDragEnd={() => setDrag(null)}
            onDrop={() => { if (drag && drag !== k) { const next = order.filter((x) => x !== drag); next.splice(next.indexOf(k), 0, drag); commitOrder(next) } setDrag(null) }}
            onMove={(dir) => move(k, dir)} onSave={(p) => onSave({ [k]: p })} />
        )
      })}
    </Card>
  )
}

function Row({ f, index, last, editable, busy, dragging, onDragStart, onDragEnd, onDrop, onMove, onSave }: {
  f: FieldRow; index: number; last: boolean; editable: boolean; busy: boolean; dragging: boolean
  onDragStart: () => void; onDragEnd: () => void; onDrop: () => void; onMove: (d: number) => void
  onSave: (p: { visible?: boolean; label?: string | null }) => void
}) {
  const e = f.effective
  const [label, setLabel] = useState(e.label)
  useEffect(() => { setLabel(e.label) }, [e.label])
  const changed = Object.keys(f.override).length > 0
  return (
    <div draggable={editable} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={(ev) => ev.preventDefault()} onDrop={onDrop}
      className={cn('flex items-center gap-3 border-b border-line px-4 py-2 last:border-0', dragging && 'opacity-40', !e.visible && 'bg-surface-2/60')}>
      {e.visible ? <Eye className="size-4 shrink-0 text-emerald-600" /> : <EyeOff className="size-4 shrink-0 text-ink-3" />}
      <Switch checked={e.visible} disabled={!editable || busy || f.system_required} label={`Show ${e.label}`} onChange={(v) => onSave({ visible: v })} />
      <Input className={cn('h-8 flex-1', !e.visible && 'text-ink-3')} value={label} disabled={!editable} aria-label={`Label for ${f.label}`}
        onChange={(ev) => setLabel(ev.target.value)}
        onBlur={() => { if (label.trim() !== e.label) onSave({ label: label.trim() && label.trim() !== f.label ? label.trim() : null }) }}
        onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur() }} />
      <div className="flex items-center gap-0.5">
        <button type="button" disabled={!editable || index === 0} onClick={() => onMove(-1)} className="rounded p-1 text-ink-3 hover:text-ink disabled:opacity-30" aria-label="Move up"><ArrowUp className="size-3.5" /></button>
        <button type="button" disabled={!editable || last} onClick={() => onMove(1)} className="rounded p-1 text-ink-3 hover:text-ink disabled:opacity-30" aria-label="Move down"><ArrowDown className="size-3.5" /></button>
        <GripVertical className={cn('size-4 text-ink-3', editable && 'cursor-grab')} aria-hidden />
      </div>
      <span className="w-6 text-center text-xs tabular-nums text-ink-3">{index + 1}</span>
      <Badge tone={changed ? 'amber' : 'gray'}>{changed ? 'yours' : 'standard'}</Badge>
    </div>
  )
}
