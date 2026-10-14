import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, Lock, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useAuth, useMeta, useRegistry } from '@/lib/auth'
import { dateTime, nowLocal, todayISO } from '@/lib/format'
import { usePref } from '@/lib/prefs'
import type { AuditRow, EntityDef, FieldDef, ListResult, ModuleStats, Rec, TransitionDef } from '@/lib/types'
import { Cell, FieldInput, FieldValue, useDebounced, useFieldMap } from './fields'
import { ColumnChooser, DensityToggle, ExportMenu, PAGE_SIZES, Pager } from './list'
import {
  Badge, Button, cn, CopyButton, Drawer, Empty, ErrorBox, FieldWrap, Input, KeyValue, Kbd, Modal, Spinner, StatusBadge, Tabs, Textarea, toneVariant,
} from './ui'

const entPath = (e: EntityDef) => `/m/${e.module}/${e.key}`
const spanOf = (f: FieldDef) => (f.width === 'full' ? 'sm:col-span-6' : f.width === 'third' ? 'sm:col-span-2' : 'sm:col-span-3')

export function useMyEmployeeId() {
  const { user } = useAuth()
  const { data } = useMeta()
  return user?.employee_id ?? data?.user.employee_id ?? null
}

function defaults(entity: EntityDef, me: string | null): Rec {
  const out: Rec = { id: '' }
  for (const f of entity.fields) {
    if (f.default === undefined || f.default === null) continue
    out[f.key] = f.default === 'today' ? todayISO() : f.default === 'now' ? nowLocal() : f.default === 'me' ? me : f.default
  }
  return out
}

// ------------------------------------------------------------------ form

export function RecordForm({ entity, initial, fixed, onSaved, onCancel, refs, submitLabel }: {
  entity: EntityDef
  initial?: Rec | null
  fixed?: Record<string, unknown>
  onSaved: (rec: Rec) => void
  onCancel?: () => void
  refs?: Record<string, string>
  submitLabel?: string
}) {
  const me = useMyEmployeeId()
  const qc = useQueryClient()
  const editing = !!initial?.id
  const [values, setValues] = useState<Rec>(() => (editing ? { ...initial! } : { ...defaults(entity, me), ...(fixed ?? {}) }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const freeStatus = !!entity.statuses?.length && !entity.transitions.length
  const visible = entity.fields.filter((f) => !f.hidden && !(fixed && f.key in fixed) && !(f.readonly && !editing))

  const save = useMutation({
    mutationFn: () => {
      const body: Rec = { ...values }
      for (const f of entity.fields) if (f.readonly || (editing && f.editable === false)) delete body[f.key]
      return editing ? api<Rec>(`${entPath(entity)}/${initial!.id}`, { method: 'PUT', body }) : api<Rec>(entPath(entity), { method: 'POST', body })
    },
    onSuccess: (rec) => {
      toast.success(`${entity.singular} ${editing ? 'updated' : 'created'} · ${rec.code ?? ''}`)
      qc.invalidateQueries({ queryKey: ['m', entity.module] })
      qc.invalidateQueries({ queryKey: ['stats', entity.module] })
      if (rec.patient_id) qc.invalidateQueries({ queryKey: ['patient', rec.patient_id] })
      onSaved(rec)
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors)
      toast.error(errorMessage(e))
    },
  })

  return (
    <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate() }}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-6">
        {entity.code_editable && !editing && (
          <FieldWrap label="Code" className="sm:col-span-3" help="Leave blank to auto-number">
            <Input value={values.code ?? ''} onChange={(e) => setValues({ ...values, code: e.target.value })} />
          </FieldWrap>
        )}
        {visible.map((f) => (
          <FieldWrap key={f.key} label={f.label} required={f.required && !f.readonly && !(editing && f.editable === false)} error={errors[f.key]}
            help={editing && f.editable === false ? 'Set when the record was created — cannot be changed' : f.type === 'boolean' ? undefined : f.help} className={spanOf(f)}>
            {f.readonly || (editing && f.editable === false) ? (
              <div className="flex min-h-9 items-center text-sm">{FieldValue({ field: f, value: values[f.key], refs: { ...refs, ...(initial?._refs ?? {}) } })}</div>
            ) : (
              <FieldInput field={f} value={values[f.key]} error={errors[f.key]} errors={errors}
                refs={{ ...refs, ...(initial?._refs ?? {}) }} patientId={(values.patient_id as string) ?? undefined}
                onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
            )}
          </FieldWrap>
        ))}
        {freeStatus && (
          <FieldWrap label="Status" className="sm:col-span-3">
            <select className="h-9 w-full rounded-lg border border-line-2 bg-surface px-3 text-sm" value={values.status ?? entity.statuses![0]}
              onChange={(e) => setValues({ ...values, status: e.target.value })}>
              {entity.statuses!.map((s) => <option key={s}>{s}</option>)}
            </select>
          </FieldWrap>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={save.isPending} icon="Save">{submitLabel ?? (editing ? 'Save changes' : `Create ${entity.singular.toLowerCase()}`)}</Button>
      </div>
    </form>
  )
}

export function RecordFormModal({ entity, open, onClose, initial, fixed, onSaved, title }: {
  entity: EntityDef; open: boolean; onClose: () => void; initial?: Rec | null; fixed?: Record<string, unknown>; onSaved?: (r: Rec) => void; title?: string
}) {
  return (
    <Modal open={open} onClose={onClose} size={entity.fields.length > 10 ? 'lg' : 'md'}
      title={title ?? (initial?.id ? `Edit ${entity.singular} ${initial.code ?? ''}` : `New ${entity.singular}`)}>
      {open && <RecordForm entity={entity} initial={initial} fixed={fixed} onCancel={onClose} onSaved={(r) => { onSaved?.(r); onClose() }} />}
    </Modal>
  )
}

// ------------------------------------------------------------------ transitions

export function TransitionDialog({ entity, rec, t, onClose, onDone }: { entity: EntityDef; rec: Rec; t: TransitionDef; onClose: () => void; onDone: (r: Rec) => void }) {
  const qc = useQueryClient()
  const fmap = useFieldMap(entity.fields)
  const fields = (t.fields ?? []).map((k) => fmap.get(k)).filter(Boolean) as FieldDef[]
  const [values, setValues] = useState<Rec>(() => Object.fromEntries(fields.map((f) => [f.key, rec[f.key] ?? null])) as Rec)
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const run = useMutation({
    mutationFn: () => api<Rec>(`${entPath(entity)}/${rec.id}/transition`, { method: 'POST', body: { to: t.to, note: note || undefined, values: fields.length ? values : undefined } }),
    onSuccess: (r) => {
      toast.success(`${rec.code}: ${t.label} → ${t.to}`)
      qc.invalidateQueries({ queryKey: ['m', entity.module] })
      qc.invalidateQueries({ queryKey: ['stats', entity.module] })
      qc.invalidateQueries({ queryKey: ['x'] })
      if (r.patient_id) qc.invalidateQueries({ queryKey: ['patient', r.patient_id] })
      onDone(r)
    },
    onError: (e) => { if (e instanceof ApiError) setErrors(e.fieldErrors); toast.error(errorMessage(e)) },
  })
  return (
    <Modal open onClose={onClose} title={`${t.label} · ${rec.code}`} size={fields.some((f) => f.type === 'lines') ? 'lg' : 'md'}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={toneVariant(t.tone)} loading={run.isPending} onClick={() => { setErrors({}); run.mutate() }}>{t.label}</Button>
      </>}>
      {t.confirm && <p className="mb-3 text-sm text-ink-2">{t.confirm}</p>}
      <div className="grid gap-3 sm:grid-cols-6">
        {fields.map((f) => (
          <FieldWrap key={f.key} label={f.label} required={t.require?.includes(f.key)} error={errors[f.key]} className="sm:col-span-6">
            <FieldInput field={{ ...f, hidden: false }} value={values[f.key]} errors={errors} refs={rec._refs} patientId={rec.patient_id}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
          </FieldWrap>
        ))}
        <FieldWrap label="Note (optional, saved in the audit trail)" className="sm:col-span-6">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FieldWrap>
      </div>
      <p className="mt-3 text-xs text-ink-3">Status will change from <b>{rec.status}</b> to <b>{t.to}</b>.</p>
    </Modal>
  )
}

// ------------------------------------------------------------------ detail drawer

export function AuditList({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <Empty icon="History" title="No activity yet" />
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {rows.map((a) => (
        <li key={a.id} className="relative">
          <span className="absolute -left-[25px] top-1 size-2.5 rounded-full border-2 border-surface bg-brand-600" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-ink">{a.user_name}</span>
            <Badge tone={a.action === 'create' ? 'green' : a.action === 'delete' ? 'red' : a.action === 'break_glass' ? 'red' : 'gray'}>{a.action}</Badge>
            <span className="text-xs text-ink-3">{dateTime(a.at)} · {a.role}</span>
          </div>
          {a.after && a.action !== 'create' && Object.keys(a.after).length > 0 && (
            <div className="mt-1 space-y-0.5 text-xs text-ink-2">
              {Object.entries(a.after).slice(0, 8).map(([k, v]) => (
                <div key={k}><span className="text-ink-3">{k}:</span> {fmtAudit(a.before?.[k])} → <span className="text-ink">{fmtAudit(v)}</span></div>
              ))}
            </div>
          )}
          {a.note && <p className="mt-1 text-xs italic text-ink-2">“{a.note}”</p>}
        </li>
      ))}
    </ol>
  )
}
const fmtAudit = (v: unknown) => (v === null || v === undefined || v === '' ? '∅' : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} items` : '{…}') : String(v).slice(0, 60))

export function RecordDetails({ entity, rec }: { entity: EntityDef; rec: Rec }) {
  const items = entity.fields
    .filter((f) => !(f.hidden && (rec[f.key] === null || rec[f.key] === undefined)))
    .map((f) => ({ label: f.label, value: FieldValue({ field: f, value: rec[f.key], refs: rec._refs, rec }), full: ['textarea', 'lines', 'signature'].includes(f.type) || f.width === 'full' }))
  return (
    <div className="space-y-5 p-5">
      <KeyValue items={items} />
      <div className="grid gap-2 rounded-lg bg-surface-2 p-3 text-xs text-ink-2 sm:grid-cols-2">
        <div>Created {dateTime(rec.created_at)}</div>
        <div>Last updated {dateTime(rec.updated_at)}</div>
      </div>
    </div>
  )
}

export function RecordDrawer({ entity, id, onClose, extraActions, children }: {
  entity: EntityDef; id: string; onClose: () => void; extraActions?: (rec: Rec) => ReactNode; children?: (rec: Rec) => ReactNode
}) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const { user } = useAuth()
  const [tab, setTab] = useState<'details' | 'activity'>('details')
  const [edit, setEdit] = useState(false)
  const [tr, setTr] = useState<TransitionDef | null>(null)
  const q = useQuery({ queryKey: ['m', entity.module, entity.key, 'one', id], queryFn: () => api<Rec>(`${entPath(entity)}/${id}`) })
  const audit = useQuery({
    queryKey: ['m', entity.module, entity.key, 'audit', id],
    queryFn: () => api<{ rows: AuditRow[] }>(`${entPath(entity)}/${id}/audit`),
    enabled: tab === 'activity',
  })
  const rec = q.data
  const canWrite = reg.canEntity(entity.fqn, 'write')
  const remove = useMutation({
    mutationFn: () => api(`${entPath(entity)}/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['m', entity.module] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const print = () => {
    api(`${entPath(entity)}/${id}/print`, { method: 'POST' }).catch(() => {})
    window.open(`/print/${entity.module}/${entity.key}/${id}`, '_blank')
  }
  return (
    <Drawer open onClose={onClose} width="max-w-3xl"
      title={rec ? <span className="flex items-center gap-2">{rec.title || entity.singular} <StatusBadge status={rec.status} /></span> : entity.singular}
      subtitle={rec && <span className="inline-flex items-center gap-1 font-mono text-xs">{rec.code} <CopyButton value={rec.code} label="Copy code" /> · {entity.label}</span>}
      footer={rec && (
        <>
          {user?.role === 'admin' && canWrite && !entity.readonly && (
            <Button variant="ghost" size="sm" icon="Trash2" className="mr-auto text-red-600" loading={remove.isPending}
              onClick={() => { if (confirm(`Delete ${rec.code}? This is soft-deleted and audited.`)) remove.mutate() }}>Delete</Button>
          )}
          <Button size="sm" icon="Printer" onClick={print}>Print</Button>
          {extraActions?.(rec)}
          {canWrite && !entity.readonly && <Button size="sm" icon="Pencil" onClick={() => setEdit(true)}>Edit</Button>}
          {canWrite && rec._transitions?.map((t) => (
            <Button key={t.to + t.label} size="sm" variant={toneVariant(t.tone)} onClick={() => setTr(t)}>{t.label}</Button>
          ))}
        </>
      )}>
      {q.isLoading && <Spinner />}
      {q.error && <div className="p-5"><ErrorBox error={q.error} /></div>}
      {rec && (
        <>
          <Tabs className="px-5" value={tab} onChange={setTab} tabs={[{ key: 'details', label: 'Details', icon: 'FileText' }, { key: 'activity', label: 'Activity & audit', icon: 'History' }]} />
          {tab === 'details' ? (
            <>
              {children?.(rec)}
              <RecordDetails entity={entity} rec={rec} />
            </>
          ) : (
            <div className="p-5">{audit.isLoading ? <Spinner /> : <AuditList rows={audit.data?.rows ?? []} />}</div>
          )}
          <RecordFormModal entity={entity} open={edit} onClose={() => setEdit(false)} initial={rec}
            onSaved={() => qc.invalidateQueries({ queryKey: ['m', entity.module, entity.key, 'one', id] })} />
          {tr && <TransitionDialog entity={entity} rec={rec} t={tr} onClose={() => setTr(null)} onDone={() => setTr(null)} />}
        </>
      )}
    </Drawer>
  )
}

// ------------------------------------------------------------------ list / table

export interface EntityViewProps {
  entity: EntityDef
  fixed?: Record<string, string>
  compact?: boolean
  hideCreate?: boolean
  columns?: string[]
  defaultStatus?: string
  title?: ReactNode
  toolbar?: ReactNode
  limit?: number
}

const BASE_COL_LABEL: Record<string, string> = {
  code: 'Code', status: 'Status', patient_id: 'Patient', employee_id: 'Employee', encounter_id: 'Encounter / visit',
  created_at: 'Created', updated_at: 'Last updated',
}

/** Columns a user may pick for an entity list (base columns + every displayable field). */
function columnOptions(entity: EntityDef): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [{ key: 'code', label: 'Code' }, { key: 'title', label: entity.singular }]
  const seen = new Set(['code', 'title'])
  for (const f of entity.fields) {
    if (f.hidden || f.type === 'signature' || f.type === 'file' || seen.has(f.key)) continue
    out.push({ key: f.key, label: f.label })
    seen.add(f.key)
  }
  for (const k of ['patient_id', 'employee_id', 'encounter_id'] as const) {
    if (!seen.has(k) && entity[k === 'patient_id' ? 'patient' : k === 'employee_id' ? 'employee' : 'encounter']) out.push({ key: k, label: BASE_COL_LABEL[k] })
  }
  if (entity.statuses?.length) out.push({ key: 'status', label: 'Status' })
  out.push({ key: 'created_at', label: 'Created' }, { key: 'updated_at', label: 'Last updated' })
  return out
}

export function EntityView({ entity, fixed, compact, hideCreate, columns, defaultStatus, title, toolbar, limit: limitProp = 25 }: EntityViewProps) {
  const reg = useRegistry()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [status, setStatus] = useState<string | undefined>(defaultStatus)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<string>(entity.sort)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [creating, setCreating] = useState(false)
  const [savedCols, setSavedCols] = usePref<string[] | null>(`cols:${entity.fqn}`, null)
  const [prefLimit, setPrefLimit] = usePref<number>('list.limit', limitProp)
  const [density, setDensity] = usePref<'comfortable' | 'compact'>('list.density', 'comfortable')
  const limit = compact ? limitProp : PAGE_SIZES.includes(prefLimit) ? prefLimit : limitProp
  const openId = params.get('r')
  const fmap = useFieldMap(entity.fields)
  const access = reg.module(entity.module)?.access.entities[entity.key]
  const canCreate = !!access?.write && !entity.readonly && !hideCreate

  useEffect(() => { setPage(1) }, [dq, status, from, to, sort, limit])
  // deep link: /m/<module>/<entity>?new=1 opens the create form (⌘K "New …" actions)
  useEffect(() => {
    if (params.get('new') !== '1' || compact) return
    if (canCreate) setCreating(true)
    const p = new URLSearchParams(params)
    p.delete('new')
    setParams(p, { replace: true })
  }, [params, canCreate, compact, setParams])

  const fixedQuery: Record<string, string> = {}
  for (const [k, v] of Object.entries(fixed ?? {})) fixedQuery[['patient_id', 'employee_id', 'encounter_id'].includes(k) ? k : `f_${k}`] = v
  const query = { q: dq, status, page, limit, sort, date_from: from, date_to: to, ...fixedQuery }
  const list = useQuery({
    queryKey: ['m', entity.module, entity.key, 'list', query],
    queryFn: () => api<ListResult>(entPath(entity), { query }),
    placeholderData: (prev) => prev,
  })
  const stats = useQuery({
    queryKey: ['stats', entity.module],
    queryFn: () => api<ModuleStats>(`/m/${entity.module}/stats`),
    enabled: !fixed && !compact,
    staleTime: 30_000,
  })
  const byStatus = stats.data?.entities[entity.key]?.by_status ?? {}
  const options = useMemo(() => columnOptions(entity), [entity])
  const defaultCols = columns ?? (fixed?.patient_id ? entity.list.filter((c) => c !== 'patient_id') : entity.list)
  const known = new Set(options.map((o) => o.key))
  const cols = (!columns && !compact && savedCols?.filter((c) => known.has(c) || BASE_COL_LABEL[c]).length ? savedCols.filter((c) => known.has(c)) : defaultCols)
    .filter((c) => !(fixed?.patient_id && c === 'patient_id'))
  const open = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('r', id); else p.delete('r')
    setParams(p, { replace: !id })
  }
  const headerLabel = (c: string) => (c === 'title' ? entity.singular : BASE_COL_LABEL[c] ?? fmap.get(c)?.label ?? c)
  const sortable = (c: string) => ['code', 'status', 'title', 'created_at', 'updated_at'].includes(c) || fmap.has(c)
  const exportQuery = { q: dq, status, sort, date_from: from, date_to: to, ...fixedQuery }
  const tight = density === 'compact'
  const filterText = [dq && `“${dq}”`, status, from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(' · ')

  if (entity.restricted && !access?.read) {
    return <Empty icon="Lock" title="Restricted records">Only authorised clinicians can open these records.</Empty>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {title && <div className="mr-2 text-sm font-semibold text-ink">{title}</div>}
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${entity.label.toLowerCase()}…`} className="pl-8 pr-8"
            data-list-search={compact ? undefined : ''} aria-label={`Search ${entity.label}`}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() } }} />
          {!compact && <span className="pointer-events-none absolute right-2 top-2"><Kbd>/</Kbd></span>}
        </div>
        {entity.date_field && !compact && (
          <div className="flex items-center gap-1 text-xs text-ink-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="From date" />
            <span>to</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" aria-label="To date" />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          {entity.restricted && <Badge tone="red"><Lock className="size-3" /> Restricted</Badge>}
          {access?.level === 'view' && !compact && <Badge tone="gray"><Eye className="size-3" /> View only</Badge>}
          {!compact && (
            <>
              <DensityToggle value={density} onChange={setDensity} />
              {!columns && <ColumnChooser all={options} value={cols} onChange={setSavedCols} onReset={() => setSavedCols(null)} />}
              <ExportMenu path={entPath(entity)} query={exportQuery} printTitle={`${entity.label} — ${reg.module(entity.module)?.name ?? ''}`}
                printColumns={cols} subtitle={[reg.meta?.hospital.name, reg.meta?.hospital.branch_name, filterText].filter(Boolean).join(' · ')} />
            </>
          )}
          {canCreate && <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>New {entity.singular.toLowerCase()}</Button>}
        </div>
      </div>

      {entity.statuses && entity.statuses.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <StatusChip active={!status} onClick={() => setStatus(undefined)} label="All" count={compact ? undefined : stats.data?.entities[entity.key]?.total} />
          {entity.statuses.map((s) => (
            <StatusChip key={s} active={status === s} onClick={() => setStatus(status === s ? undefined : s)} label={s} count={compact ? undefined : byStatus[s] ?? 0} />
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="overflow-x-auto scroll-thin">
          <table className={cn('w-full', tight ? 'text-xs' : 'text-sm')}>
            <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>
                {cols.map((c) => (
                  <th key={c} className={cn('whitespace-nowrap px-3 text-left font-medium', tight ? 'py-1.5' : 'py-2')}>
                    {sortable(c) ? (
                      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort(sort === c ? `-${c}` : c)}>
                        {headerLabel(c)}
                        {sort === c ? <ArrowUp className="size-3" /> : sort === `-${c}` ? <ArrowDown className="size-3" /> : null}
                      </button>
                    ) : headerLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn(list.isFetching && 'opacity-70')}>
              {list.data?.rows.map((r) => (
                <tr key={r.id} onClick={() => open(r.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(r.id) }}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none">
                  {cols.map((c) => <td key={c} className={cn('max-w-xs truncate whitespace-nowrap px-3', tight ? 'py-1' : 'py-2')}><Cell col={c} rec={r} fields={fmap} refs={list.data!.refs} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-4"><ErrorBox error={list.error} /></div>}
        {list.data && list.data.rows.length === 0 && (
          <Empty icon={entity.icon ?? 'Inbox'} title={`No ${entity.label.toLowerCase()} ${dq || status ? 'match the filters' : 'yet'}`}
            action={canCreate && !dq && !status ? <Button icon="Plus" variant="primary" onClick={() => setCreating(true)}>New {entity.singular.toLowerCase()}</Button> : undefined} />
        )}
        {list.data && (list.data.total > limit || !compact) && list.data.total > 0 && (
          <Pager page={page} limit={limit} total={list.data.total} onPage={setPage} fetching={list.isFetching}
            onLimit={compact ? undefined : (n) => setPrefLimit(n)} />
        )}
      </div>

      {openId && <RecordDrawer entity={entity} id={openId} onClose={() => open(null)} />}
      <RecordFormModal entity={entity} open={creating} onClose={() => setCreating(false)} fixed={fixed} onSaved={(r) => open(r.id)} />
    </div>
  )
}

function StatusChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button onClick={onClick}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
        active ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
      {label}
      {count !== undefined && <span className={cn('tabular rounded-full px-1', active ? 'bg-white/20' : 'bg-surface-2')}>{count}</span>}
    </button>
  )
}

export function NewButton({ entity, fixed, label, onSaved, variant = 'primary' }: { entity?: EntityDef; fixed?: Record<string, unknown>; label?: string; onSaved?: (r: Rec) => void; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false)
  const reg = useRegistry()
  if (!entity || !reg.canEntity(entity.fqn, 'write') || entity.readonly) return null
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}><Plus className="size-4" />{label ?? entity.singular}</Button>
      <RecordFormModal entity={entity} open={open} onClose={() => setOpen(false)} fixed={fixed} onSaved={onSaved} />
    </>
  )
}

/** Small helper for bespoke pages: the entity definition by fqn (throws a readable placeholder if missing). */
export function useEntity(fqn: string): EntityDef | undefined {
  const reg = useRegistry()
  return useMemo(() => reg.entity(fqn), [reg, fqn])
}
