import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Copy, Lock, RotateCcw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Select, Spinner, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { Icon } from '@/lib/icons'
import type { Level } from '@/lib/types'

interface RoleRow { key: string; label: string; custom: boolean; base: string | null; description?: string | null; users: number; overrides: number; visible: number; editable: number }
interface Item { key: string; label: string; icon?: string; level: Level; default: Level; restricted?: boolean; readonly?: boolean }
interface ModRow { id: string; no: number; name: string; icon: string; pages: Item[]; entities: Item[] }
interface Matrix { role: RoleRow; locked: boolean; suites: { id: string; name: string; short: string; modules: ModRow[] }[]; counts: Record<Level, number> }

const LEVELS: { key: Level; label: string; on: string }[] = [
  { key: 'none', label: 'None', on: 'bg-slate-600 text-white' },
  { key: 'view', label: 'View', on: 'bg-sky-700 text-white' },
  { key: 'edit', label: 'Edit', on: 'bg-emerald-700 text-white' },
]

function LevelPicker({ value, onChange, disabled, mixed }: { value?: Level; onChange: (l: Level) => void; disabled?: boolean; mixed?: boolean }) {
  return (
    <div className={cn('inline-flex shrink-0 rounded-lg border border-line-2 bg-surface-2 p-0.5', disabled && 'opacity-60')} role="radiogroup">
      {LEVELS.map((l) => (
        <button key={l.key} type="button" role="radio" aria-checked={value === l.key} disabled={disabled} onClick={() => onChange(l.key)}
          className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors',
            value === l.key && !mixed ? l.on : 'text-ink-2 hover:bg-surface hover:text-ink')}>
          {l.label}
        </button>
      ))}
    </div>
  )
}

export default function RolesPermissions() {
  const reg = useRegistry()
  const qc = useQueryClient()
  const [sel, setSel] = useState('doctor')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'visible' | 'changed'>('all')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [creating, setCreating] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<RoleRow[]>('/admin/roles') })
  const matrix = useQuery({ queryKey: ['admin', 'roles', sel], queryFn: () => api<Matrix>(`/admin/roles/${sel}`) })

  const refresh = (m: Matrix) => {
    qc.setQueryData(['admin', 'roles', sel], m)
    qc.invalidateQueries({ queryKey: ['admin', 'roles'], exact: true })
    qc.invalidateQueries({ queryKey: ['meta'] })
  }
  const save = useMutation({
    mutationFn: (changes: Record<string, Level | null>) => api<Matrix>(`/admin/roles/${sel}`, { method: 'PUT', body: { changes } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const copy = useMutation({
    mutationFn: () => api<Matrix>(`/admin/roles/${sel}/copy`, { method: 'POST', body: { from_role: copyFrom } }),
    onSuccess: (m) => { refresh(m); toast.success(`Copied permissions from ${roleLabel(copyFrom)}`); setCopyFrom('') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reset = useMutation({
    mutationFn: () => api<Matrix>(`/admin/roles/${sel}/overrides`, { method: 'DELETE' }),
    onSuccess: (m) => { refresh(m); toast.success('Back to the default permissions') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: () => api(`/admin/roles/${sel}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Role deleted'); setSel('doctor'); qc.invalidateQueries({ queryKey: ['admin', 'roles'] }); qc.invalidateQueries({ queryKey: ['meta'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const roleLabel = (k: string) => roles.data?.find((r) => r.key === k)?.label ?? reg.meta?.roles[k] ?? k

  const f = q.trim().toLowerCase()
  const suites = useMemo(() => (matrix.data?.suites ?? []).map((s) => ({
    ...s,
    modules: s.modules.map((m) => {
      const modHit = !f || `${m.name} ${m.no} ${m.id}`.toLowerCase().includes(f)
      const keep = (it: Item) => (modHit || it.label.toLowerCase().includes(f)) &&
        (filter === 'all' || (filter === 'visible' ? it.level !== 'none' : it.level !== it.default))
      return { ...m, pages: m.pages.filter(keep), entities: m.entities.filter(keep) }
    }).filter((m) => m.pages.length + m.entities.length > 0),
  })).filter((s) => s.modules.length > 0), [matrix.data, f, filter])

  const locked = !!matrix.data?.locked
  const role = matrix.data?.role
  const setModule = (m: ModRow, lv: Level) => {
    const changes: Record<string, Level> = {}
    for (const p of m.pages) changes[`page:${m.id}.${p.key}`] = lv === 'view' ? 'view' : lv
    for (const e of m.entities) changes[`entity:${m.id}.${e.key}`] = lv
    save.mutate(changes)
  }

  return (
    <div>
      <PageHeader icon="ShieldCheck" title="Roles & permissions"
        subtitle="What each role can see and use. View = open and read; Edit = create, change and run workflows. Anything set to None is hidden from that role everywhere — menus, launcher, search and the APIs."
        actions={<Button icon="Plus" variant="primary" onClick={() => setCreating(true)}>New custom role</Button>} />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card pad={false} className="h-fit lg:sticky lg:top-20">
          <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Roles</div>
          {roles.isLoading && <Spinner />}
          <nav className="max-h-[70vh] overflow-y-auto py-1 scroll-thin">
            {roles.data?.map((r) => (
              <button key={r.key} onClick={() => setSel(r.key)}
                className={cn('flex w-full items-center gap-2 px-3 py-2 text-left', sel === r.key ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                    {r.label}{r.custom && <Badge tone="violet">custom</Badge>}
                  </span>
                  <span className="block text-xs text-ink-3">{r.users} user{r.users === 1 ? '' : 's'} · {r.visible} visible{r.overrides ? ` · ${r.overrides} changed` : ''}</span>
                </span>
                {r.key === 'admin' && <Lock className="size-3.5 text-ink-3" />}
              </button>
            ))}
          </nav>
        </Card>

        <div className="min-w-0 space-y-3">
          {matrix.error && <ErrorBox error={matrix.error} />}
          {matrix.isLoading && <Spinner />}
          {role && (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-base font-semibold text-ink"><ShieldCheck className="size-5 text-brand-700" /> {role.label}
                    {role.custom && <Badge tone="violet">custom · based on {roleLabel(role.base ?? '')}</Badge>}</h2>
                  <p className="mt-0.5 text-sm text-ink-2">
                    {matrix.data!.counts.edit} editable · {matrix.data!.counts.view} view-only · {matrix.data!.counts.none} hidden
                    {role.custom && ' · engine rules (approvals, transitions) follow the base role'}
                  </p>
                  {role.description && <p className="mt-1 text-xs text-ink-3">{role.description}</p>}
                </div>
                {!locked && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select className="h-8 w-44 text-xs" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} aria-label="Copy from role">
                      <option value="">Copy from role…</option>
                      {roles.data?.filter((r) => r.key !== sel).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </Select>
                    <Button size="sm" disabled={!copyFrom} loading={copy.isPending}
                      onClick={() => { if (confirm(`Replace ${role.label}'s permissions with ${roleLabel(copyFrom)}'s?`)) copy.mutate() }}>
                      <Copy className="size-4" /> Copy
                    </Button>
                    <Button size="sm" loading={reset.isPending} onClick={() => { if (confirm(`Reset ${role.label} to the default permissions?`)) reset.mutate() }}>
                      <RotateCcw className="size-4" /> Reset to defaults
                    </Button>
                    {role.custom && (
                      <Button size="sm" variant="ghost" className="text-red-600" loading={remove.isPending}
                        onClick={() => { if (confirm(`Delete the custom role ${role.label}?`)) remove.mutate() }}><Trash2 className="size-4" /> Delete</Button>
                    )}
                  </div>
                )}
              </div>
              {locked && <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2"><Lock className="mr-1 inline size-4" /> The administrator role always has full access so the system can never be locked out.</p>}
            </Card>
          )}

          {matrix.data && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-60 flex-1 sm:max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
                <Input className="pl-8" placeholder="Filter modules, workspaces, record types…" value={q} onChange={(e) => setQ(e.target.value)} data-list-search="" />
              </div>
              <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
                {(['all', 'visible', 'changed'] as const).map((k) => (
                  <button key={k} onClick={() => setFilter(k)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium', filter === k ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2')}>
                    {k === 'all' ? 'All' : k === 'visible' ? 'Visible to role' : 'Changed from default'}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOpen(Object.fromEntries(suites.flatMap((s) => s.modules.map((m) => [m.id, true]))))}>Expand all</Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen({})}>Collapse all</Button>
            </div>
          )}

          {matrix.data && suites.length === 0 && <Empty icon="SearchX" title="Nothing matches the filter" />}
          {suites.map((s) => (
            <section key={s.id}>
              <h3 className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wider text-ink-3">{s.name}</h3>
              <div className="overflow-hidden rounded-xl border border-line bg-surface">
                {s.modules.map((m) => {
                  const items = [...m.pages, ...m.entities]
                  const lv = new Set(items.map((i) => i.level))
                  const modLevel = lv.size === 1 ? [...lv][0] : undefined
                  const changed = items.filter((i) => i.level !== i.default).length
                  const isOpen = open[m.id] ?? (!!f || filter !== 'all')
                  return (
                    <div key={m.id} className="border-b border-line last:border-0">
                      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen({ ...open, [m.id]: !isOpen })} aria-expanded={isOpen}>
                          <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition-transform', !isOpen && '-rotate-90')} />
                          <Icon name={m.icon} className="size-4 shrink-0 text-brand-700 dark:text-brand-400" />
                          <span className="truncate text-sm font-medium text-ink">{m.name}</span>
                          <span className="shrink-0 text-xs text-ink-3">
                            {items.filter((i) => i.level === 'edit').length} edit · {items.filter((i) => i.level === 'view').length} view
                          </span>
                          {changed > 0 && <Badge tone="amber">{changed} changed</Badge>}
                        </button>
                        <LevelPicker value={modLevel} mixed={!modLevel} disabled={locked || save.isPending} onChange={(l) => setModule(m, l)} />
                      </div>
                      {isOpen && (
                        <div className="border-t border-line bg-surface-2/50 pb-1">
                          {m.pages.length > 0 && <Row heading="Workspaces" />}
                          {m.pages.map((p) => <ItemRow key={p.key} it={p} kind="Workspace" locked={locked} busy={save.isPending}
                            onChange={(l) => save.mutate({ [`page:${m.id}.${p.key}`]: l })} onReset={() => save.mutate({ [`page:${m.id}.${p.key}`]: null })} />)}
                          {m.entities.length > 0 && <Row heading="Record types" />}
                          {m.entities.map((e) => <ItemRow key={e.key} it={e} kind="Records" locked={locked} busy={save.isPending}
                            onChange={(l) => save.mutate({ [`entity:${m.id}.${e.key}`]: l })} onReset={() => save.mutate({ [`entity:${m.id}.${e.key}`]: null })} />)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      {creating && <NewRole roles={roles.data ?? []} onClose={() => setCreating(false)} onCreated={(k) => { setCreating(false); setSel(k) }} />}
    </div>
  )
}

function Row({ heading }: { heading: string }) {
  return <div className="px-10 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{heading}</div>
}

function ItemRow({ it, locked, busy, onChange, onReset }: { it: Item; kind: string; locked: boolean; busy: boolean; onChange: (l: Level) => void; onReset: () => void }) {
  const changed = it.level !== it.default
  return (
    <div className="flex items-center gap-3 py-1 pl-10 pr-3 hover:bg-surface">
      <Icon name={it.icon ?? 'Dot'} className="size-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{it.label}</span>
      {it.restricted && <Badge tone="red"><Lock className="size-3" /> restricted</Badge>}
      {it.readonly && <Badge tone="gray">system-managed</Badge>}
      {changed && (
        <button type="button" onClick={onReset} disabled={locked || busy} title={`Default: ${it.default}. Click to restore.`}
          className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-amber-700 hover:underline dark:text-amber-300">
          <RotateCcw className="size-3" /> default {it.default}
        </button>
      )}
      <LevelPicker value={it.level} disabled={locked || busy} onChange={onChange} />
    </div>
  )
}

function NewRole({ roles, onClose, onCreated }: { roles: RoleRow[]; onClose: () => void; onCreated: (key: string) => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({ label: '', key: '', base: 'nurse', copy_from: '', description: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const builtin = roles.filter((r) => !r.custom && r.key !== 'admin')
  const create = useMutation({
    mutationFn: () => api<Matrix>('/admin/roles', { method: 'POST', body: { ...form, key: form.key || slug(form.label), copy_from: form.copy_from || undefined, description: form.description || undefined } }),
    onSuccess: (m) => { toast.success(`Role ${m.role.label} created`); qc.invalidateQueries({ queryKey: ['admin', 'roles'] }); qc.invalidateQueries({ queryKey: ['meta'] }); onCreated(m.role.key) },
    onError: (e) => { const d = (e as { fieldErrors?: Record<string, string> }).fieldErrors; if (d) setErrors(d); toast.error(errorMessage(e)) },
  })
  return (
    <Modal open onClose={onClose} title="New custom role" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="Plus" loading={create.isPending} disabled={form.label.trim().length < 2} onClick={() => create.mutate()}>Create role</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Name" required><Input autoFocus value={form.label} placeholder="e.g. Ward In-charge, Cashier" onChange={(e) => setForm({ ...form, label: e.target.value })} /></FieldWrap>
        <FieldWrap label="Key" help={`Used internally: ${form.key || slug(form.label) || '—'}`} error={errors.key}>
          <Input value={form.key} placeholder={slug(form.label)} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
        </FieldWrap>
        <FieldWrap label="Based on" required help="Workflow rules (who may approve, discharge, verify…) follow this built-in role." error={errors.base}>
          <Select value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })}>
            {builtin.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>
        </FieldWrap>
        <FieldWrap label="Start from the permissions of" help="Leave empty to start from the base role's defaults.">
          <Select value={form.copy_from} onChange={(e) => setForm({ ...form, copy_from: e.target.value })}>
            <option value="">{roles.find((r) => r.key === form.base)?.label ?? 'Base role'} (defaults)</option>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>
        </FieldWrap>
        <FieldWrap label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></FieldWrap>
      </div>
    </Modal>
  )
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
