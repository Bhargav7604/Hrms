import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, PageHeader, Spinner, Switch, Tabs } from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'

type Form = 'op.clinical_note' | 'op.vitals' | 'op.prescription'
interface FieldRow { key: string; label: string; system_required: boolean; effective: { visible: boolean; label: string; order: number }; override: Record<string, unknown> }
interface FormDef { label: string; sections: { key: string; label: string; fields: FieldRow[] }[]; can_edit: boolean }
interface Row { key: string; label: string; std: string; visible: boolean; locked: boolean }

/** My Consultation Format — each doctor arranges the OP clinical note, vitals and prescription for themselves
 * (show / hide, rename, reorder). Admins arrange it for any doctor; everyone else sees a read-only preview. */
export default function ConsultationFormat({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'admin'
  const [form, setForm] = useState<Form>('op.clinical_note')
  const [doctor, setDoctor] = useState<string | null>(user?.role === 'doctor' ? user.employee_id ?? null : null)
  const editableScope = !!doctor && (isAdmin || (user?.role === 'doctor' && doctor === user.employee_id))
  const def = useQuery({
    queryKey: ['x', 'settings', 'consult-format', form, doctor],
    queryFn: () => api<FormDef>(`/fieldconfig/forms/${form}`, { query: { scope: 'doctor', scope_id: doctor! } }),
    enabled: editableScope,
  })
  const preview = useQuery({
    queryKey: ['x', 'settings', 'screen', form],
    queryFn: () => api<{ fields: Record<string, { visible: boolean; label: string; order: number; section: string }>; sections: { key: string; label: string; fields: string[] }[] }>(`/fieldconfig/screens/${form}`),
    enabled: !editableScope,
  })
  const [rows, setRows] = useState<Record<string, Row[]>>({})
  useEffect(() => {
    if (editableScope && def.data) {
      setRows(Object.fromEntries(def.data.sections.map((s) => [s.key, s.fields.map((f) => ({ key: f.key, label: f.effective.label, std: f.label, visible: f.effective.visible, locked: f.system_required }))])))
    } else if (!editableScope && preview.data) {
      const fs = preview.data.fields
      setRows(Object.fromEntries(preview.data.sections.map((s) => [s.key, s.fields.map((k) => ({ key: k, label: fs[k]?.label ?? k, std: fs[k]?.label ?? k, visible: fs[k]?.visible !== false, locked: false }))])))
    }
  }, [def.data, preview.data, editableScope])
  const sections = editableScope ? def.data?.sections.map((s) => ({ key: s.key, label: s.label })) : preview.data?.sections.map((s) => ({ key: s.key, label: s.label }))
  const save = useMutation({
    mutationFn: () => {
      const fields: Record<string, Record<string, unknown>> = {}
      for (const list of Object.values(rows)) list.forEach((r, i) => { fields[r.key] = { visible: r.visible, label: r.label !== r.std ? r.label : null, order: i } })
      return api(`/fieldconfig/forms/${form}`, { method: 'PUT', body: { scope: 'doctor', scope_id: doctor, fields } })
    },
    onSuccess: () => { toast.success('Your format is saved'); qc.invalidateQueries({ queryKey: ['x', 'settings'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reset = useMutation({
    mutationFn: (section: string) => api(`/fieldconfig/forms/${form}`, { method: 'DELETE', query: { scope: 'doctor', scope_id: doctor!, section } }),
    onSuccess: () => { toast.success('Section reset to the department format'); qc.invalidateQueries({ queryKey: ['x', 'settings'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const move = (sec: string, i: number, d: -1 | 1) => setRows((r) => {
    const list = [...(r[sec] ?? [])]
    const j = i + d
    if (j < 0 || j >= list.length) return r
    ;[list[i], list[j]] = [list[j], list[i]]
    return { ...r, [sec]: list }
  })
  const upd = (sec: string, i: number, patch: Partial<Row>) => setRows((r) => ({ ...r, [sec]: (r[sec] ?? []).map((x, k) => (k === i ? { ...x, ...patch } : x)) }))
  const err = def.error ?? preview.error
  return (
    <div className="space-y-3">
      {!embedded && <PageHeader icon="SlidersHorizontal" title="My Consultation Format" subtitle="Arrange your own consultation screen — hide fields you never fill, rename them, put the ones you use first. Only your screen changes." />}
      <div className="flex flex-wrap items-end gap-3">
        {isAdmin && <FieldWrap label="Arranging for" className="w-72"><RefPicker refName="employees.employees" kind="doctor" filter={{ category: 'Doctor' }} value={doctor} onChange={setDoctor} placeholder="Choose a doctor" /></FieldWrap>}
        {editableScope && <Button variant="primary" icon="Save" className="ml-auto" loading={save.isPending} onClick={() => save.mutate()}>Save my format</Button>}
      </div>
      <Tabs<Form> value={form} onChange={setForm} tabs={[{ key: 'op.clinical_note', label: 'OP clinical note' }, { key: 'op.vitals', label: 'OP vitals' }, { key: 'op.prescription', label: 'OP prescription' }]} />
      {!editableScope && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2"><b>Read-only preview.</b> {isAdmin ? 'Pick a doctor in “Arranging for” to change their format, or use Field Configuration for a whole department.' : 'This login is not linked to a doctor, so it has no format of its own — you are seeing the standard one.'}</p>}
      {err && !(err instanceof ApiError && err.status === 404) && <ErrorBox error={err} />}
      {(def.isLoading || preview.isLoading) && <Spinner />}
      {sections?.length === 0 && <Empty icon="SlidersHorizontal" title="Nothing to arrange" />}
      {sections?.map((s) => {
        const list = rows[s.key] ?? []
        return (
          <Card key={s.key} title={<span>{s.label} <span className="text-xs font-normal text-ink-3">{list.filter((r) => r.visible).length} of {list.length} shown</span></span>}
            actions={editableScope && <Button size="xs" icon="RotateCcw" loading={reset.isPending} onClick={() => reset.mutate(s.key)}>Reset this section</Button>} pad={false}>
            <ul className="divide-y divide-line">
              {list.map((r, i) => (
                <li key={r.key} className={cn('flex items-center gap-3 px-4 py-1.5', !r.visible && 'opacity-60')}>
                  {r.visible ? <Eye className="size-4 text-ink-3" /> : <EyeOff className="size-4 text-ink-3" />}
                  <Switch size="sm" checked={r.visible} disabled={!editableScope || r.locked} label={`Show ${r.label}`} onChange={(v) => upd(s.key, i, { visible: v })} />
                  <Input className="h-8 flex-1" value={r.label} disabled={!editableScope} onChange={(e) => upd(s.key, i, { label: e.target.value })} aria-label={`Label for ${r.std}`} />
                  {editableScope && <>
                    <Button size="xs" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(s.key, i, -1)}><ArrowUp className="size-4" /></Button>
                    <Button size="xs" variant="ghost" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(s.key, i, 1)}><ArrowDown className="size-4" /></Button>
                  </>}
                  <Badge tone={r.locked ? 'amber' : 'gray'}>{r.locked ? 'required' : 'standard'}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )
      })}
    </div>
  )
}
