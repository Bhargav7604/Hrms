import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Building, Building2, ChevronRight, Copy, Eye, EyeOff, LayoutGrid, List, Lock, Pencil, RotateCcw, Search, Sparkles, Stethoscope, Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Select, Spinner, Switch } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useBranch, useRegistry } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'

export type Scope = 'org' | 'branch' | 'department' | 'doctor'
export interface Eff { visible: boolean; hidden: boolean; required: boolean; readonly: boolean; editable: boolean; label: string; default: unknown; mask: boolean; order: number; section: string }
export interface FieldRow {
  key: string; label: string; type: string; visible: boolean; required: boolean; readonly: boolean; editable: boolean; default: unknown; mask: boolean
  system_required: boolean; system_readonly: boolean; help?: string | null
  effective: Eff; inherited: Eff; override: Partial<Eff>
}
export interface SettingDef { key: string; label: string; type: 'boolean' | 'number' | 'text' | 'select' | 'multiselect' | 'field'; default: unknown; options?: (string | { value: string; label: string })[]; help?: string; min?: number; max?: number }
export interface FormDef {
  key: string; label: string; namespace: string; kind: 'screen' | 'entity'; group: string; icon?: string; description?: string; personal: boolean
  sections: { key: string; label: string; description?: string | null; icon?: string | null; fields: FieldRow[] }[]
  settings: SettingDef[]; settings_values: Record<string, unknown>; settings_override: Record<string, unknown>
  scope: Scope; scope_id: string; updated_at?: string | null; updated_by?: string | null; layers: { scope: string; scope_id: string; updated_at: string }[]; can_edit: boolean
}
interface FormList { screens: { key: string; label: string; group: string; icon: string; personal: boolean; sections: number; fields: number; settings: number; layers: number }[]; entities: { key: string; label: string; module: string; icon: string; fields: number; layers: number }[] }

const SCOPES: { key: Scope; label: string; icon: typeof Building }[] = [
  { key: 'org', label: 'Organization', icon: Building },
  { key: 'branch', label: 'Branch', icon: Building2 },
  { key: 'department', label: 'Department', icon: Users },
  { key: 'doctor', label: 'Doctor', icon: Stethoscope },
]
const SCOPE_TEXT: Record<Scope, string> = {
  org: 'Editing the organization defaults — every branch inherits these unless it overrides them.',
  branch: 'Editing the active branch — overrides the organization defaults.',
  department: 'Editing one department — overrides its branch and the organization.',
  doctor: "Editing one doctor's own screen — the most specific level; it wins over everything else.",
}

type Status = '' | 'visible' | 'hidden' | 'required' | 'readonly' | 'changed'

export default function FieldConfig() {
  const reg = useRegistry()
  const qc = useQueryClient()
  const { branch, branches } = useBranch()
  const [params, setParams] = useSearchParams()
  const form = params.get('form') ?? 'registration'
  const [scope, setScope] = useState<Scope>((params.get('scope') as Scope) || 'branch')
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [view, setView] = useState<'card' | 'list'>('card')
  const [q, setQ] = useState('')
  const [section, setSection] = useState('')
  const [status, setStatus] = useState<Status>('')
  const [copyOpen, setCopyOpen] = useState(false)
  const isAdmin = reg.meta?.user.role === 'admin'
  useEffect(() => { setScopeId(scope === 'branch' ? branch ?? null : null) }, [scope, branch])

  const forms = useQuery({ queryKey: ['fieldconfig', 'forms'], queryFn: () => api<FormList>('/fieldconfig/forms'), staleTime: 60_000 })
  const needsTarget = (scope === 'department' || scope === 'doctor') && !scopeId
  const def = useQuery({
    queryKey: ['fieldconfig', 'form', form, scope, scopeId],
    queryFn: () => api<FormDef>(`/fieldconfig/forms/${form}`, { query: { scope, scope_id: scopeId ?? undefined } }),
    enabled: !needsTarget,
    placeholderData: (p) => p,
  })
  const onSaved = (d: FormDef) => {
    qc.setQueryData(['fieldconfig', 'form', form, scope, scopeId], d)
    qc.invalidateQueries({ queryKey: ['meta'] })
    qc.invalidateQueries({ queryKey: ['fieldconfig', 'forms'] })
  }
  const save = useMutation({
    mutationFn: (body: { fields?: Record<string, Partial<Eff> | null>; settings?: Record<string, unknown> }) =>
      api<FormDef>(`/fieldconfig/forms/${form}`, { method: 'PUT', body: { scope, scope_id: scopeId, fields: body.fields ?? {}, settings: body.settings } }),
    onSuccess: onSaved,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reset = useMutation({
    mutationFn: () => api<FormDef>(`/fieldconfig/forms/${form}`, { method: 'DELETE', query: { scope, scope_id: scopeId ?? undefined } }),
    onSuccess: (d) => { onSaved(d); toast.success('Reset — this level now inherits everything') },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const d = def.data
  const all = useMemo(() => d?.sections.flatMap((s) => s.fields.map((f) => ({ ...f, sectionLabel: s.label, sectionKey: s.key }))) ?? [], [d])
  const totals = {
    sections: d?.sections.length ?? 0,
    visible: all.filter((f) => f.effective.visible).length,
    required: all.filter((f) => f.effective.required).length,
    readonly: all.filter((f) => f.effective.readonly).length,
    hidden: all.filter((f) => !f.effective.visible).length,
  }
  const needle = q.trim().toLowerCase()
  const filtered = all.filter((f) => (!section || f.sectionKey === section) &&
    (!needle || `${f.effective.label} ${f.label} ${f.key} ${f.sectionLabel}`.toLowerCase().includes(needle)) &&
    (!status || (status === 'visible' ? f.effective.visible : status === 'hidden' ? !f.effective.visible : status === 'required' ? f.effective.required
      : status === 'readonly' ? f.effective.readonly : Object.keys(f.override).length > 0)))
  const setField = (key: string, patch: Partial<Eff> | null) => save.mutate({ fields: { [key]: patch } })
  const pickForm = (k: string) => { const p = new URLSearchParams(params); p.set('form', k); setParams(p, { replace: true }); setSection(''); setQ('') }
  const groups = useMemo(() => {
    const m = new Map<string, FormList['screens']>()
    for (const s of forms.data?.screens ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s])
    return [...m.entries()]
  }, [forms.data])
  const entityForm = !forms.data?.screens.some((s) => s.key === form)

  if (!isAdmin && reg.meta) return <Empty icon="Lock" title="Administrators only">Field configuration changes forms for everyone. Doctors can arrange their own screen in My consultation format.</Empty>

  return (
    <div>
      <PageHeader icon="SlidersHorizontal" title="Field Configuration" subtitle={SCOPE_TEXT[scope]}
        actions={<>
          <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5" role="radiogroup" aria-label="Scope">
            {SCOPES.map((s) => (
              <button key={s.key} role="radio" aria-checked={scope === s.key} onClick={() => setScope(s.key)}
                className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium', scope === s.key ? 'bg-brand-800 text-white' : 'text-ink-2 hover:text-ink')}>
                <s.icon className="size-3.5" /> {s.label}
              </button>
            ))}
          </div>
          {scope === 'branch' && branches.length > 0 && (
            <Select className="h-8 w-48 text-xs" value={scopeId ?? ''} onChange={(e) => setScopeId(e.target.value)} aria-label="Branch">
              {branches.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
            </Select>
          )}
          {scope === 'department' && <div className="w-56"><RefPicker refName="mdm.departments" value={scopeId} placeholder="Choose department…" onChange={(id) => setScopeId(id)} /></div>}
          {scope === 'doctor' && <div className="w-56"><RefPicker refName="employees.employees" filter={{ category: 'Doctor' }} value={scopeId} placeholder="Choose doctor…" onChange={(id) => setScopeId(id)} /></div>}
          <Button size="sm" onClick={() => setCopyOpen(true)} disabled={scope !== 'branch'} title={scope !== 'branch' ? 'Switch to Branch scope to copy between branches' : undefined}>
            <Copy className="size-4" /> Copy from branch
          </Button>
          <Button size="sm" loading={reset.isPending} disabled={!d || needsTarget}
            onClick={() => { if (confirm(`Reset "${d?.label}" at this ${scope} level to the inherited defaults?`)) reset.mutate() }}>
            <RotateCcw className="size-4" /> Reset to default
          </Button>
        </>} />

      {/* form tabs */}
      <div className="mb-4 space-y-2 rounded-xl border border-line bg-surface p-3">
        {groups.map(([g, list]) => (
          <div key={g} className="flex flex-wrap items-center gap-1">
            <span className="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g}</span>
            {list.map((s) => (
              <button key={s.key} onClick={() => pickForm(s.key)}
                className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm', form === s.key ? 'bg-brand-50 font-medium text-brand-800 ring-1 ring-brand-700/30 dark:bg-brand-500/10 dark:text-brand-200' : 'text-ink-2 hover:bg-surface-2')}>
                <Icon name={s.icon} className="size-4" /> {s.label}
                {s.layers > 0 && <span className="size-1.5 rounded-full bg-amber-500" title="Has configuration" />}
              </button>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <span className="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Record forms</span>
          <Select className="h-8 max-w-md text-sm" value={entityForm ? form : ''} onChange={(e) => e.target.value && pickForm(e.target.value)} aria-label="Any record form">
            <option value="">Any record form ({forms.data?.entities.length ?? 0})…</option>
            {forms.data?.entities.map((e) => <option key={e.key} value={e.key}>{e.module} — {e.label}{e.layers ? ' •' : ''}</option>)}
          </Select>
          {entityForm && d && <Badge tone="cyan">{d.label}</Badge>}
        </div>
      </div>

      {needsTarget && <Empty icon={scope === 'doctor' ? 'Stethoscope' : 'Users'} title={`Choose a ${scope} to configure`}>Pick one above. Its settings override the branch and organization levels.</Empty>}
      {def.error && <ErrorBox error={def.error} />}
      {!needsTarget && def.isLoading && <Spinner />}
      {d && !needsTarget && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile icon="Layers" label="Total sections" sub="Configured" value={totals.sections} />
            <Tile icon="Eye" label="Visible fields" sub="Enabled" value={totals.visible} />
            <Tile icon="Star" label="Required fields" sub="Mandatory" value={totals.required} />
            <Tile icon="Lock" label="Read-only fields" sub="Locked" value={totals.readonly} />
            <Tile icon="EyeOff" label="Hidden fields" sub="Disabled" value={totals.hidden} />
            <div className="flex items-start gap-2 rounded-xl border border-brand-700/20 bg-brand-50 px-3 py-2.5 dark:bg-brand-500/10">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-700 dark:text-brand-300" />
              <div className="text-xs"><div className="font-semibold text-ink">How it works</div><div className="text-ink-2">Show, require or lock fields per branch, department or doctor. The most specific level wins.</div></div>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-60 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
              <Input className="pl-8" placeholder="Search fields or sections…" value={q} onChange={(e) => setQ(e.target.value)} data-list-search="" />
            </div>
            <Select className="w-48" value={section} onChange={(e) => { setSection(e.target.value); if (e.target.value) setView('list') }} aria-label="Section">
              <option value="">All sections</option>
              {d.sections.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
            <Select className="w-44" value={status} onChange={(e) => { setStatus(e.target.value as Status); if (e.target.value) setView('list') }} aria-label="Status">
              <option value="">All status</option>
              <option value="visible">Visible</option>
              <option value="hidden">Hidden</option>
              <option value="required">Required</option>
              <option value="readonly">Read-only</option>
              <option value="changed">Changed at this level</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setSection(''); setStatus('') }}>Clear filters</Button>
            <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
              <button onClick={() => setView('card')} className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium', view === 'card' ? 'bg-brand-800 text-white' : 'text-ink-2')}><LayoutGrid className="size-3.5" /> Card view</button>
              <button onClick={() => setView('list')} className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium', view === 'list' ? 'bg-brand-800 text-white' : 'text-ink-2')}><List className="size-3.5" /> List view</button>
            </div>
          </div>
          {d.updated_at && <p className="mb-2 text-xs text-ink-3">This level last changed {dateTime(d.updated_at)}.</p>}

          {view === 'card' ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {d.settings.length > 0 && (
                <button onClick={() => { setView('list'); setSection('') }} className="flex flex-col rounded-xl border border-line bg-surface p-3 text-left hover:border-brand-600/40">
                  <span className="flex items-start gap-2"><Icon name="Settings2" className="mt-0.5 size-4 text-brand-700" />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-ink">{d.label} settings</span><span className="block text-xs text-ink-2">Preferences and limits for this screen.</span></span>
                    <Badge tone="gray">Settings</Badge></span>
                  <span className="mt-auto flex justify-end pt-3 text-ink-3"><ChevronRight className="size-4" /></span>
                </button>
              )}
              {d.sections.map((s) => {
                const fs = s.fields.filter((f) => !needle || `${f.effective.label} ${f.key}`.toLowerCase().includes(needle) || s.label.toLowerCase().includes(needle))
                if (!fs.length) return null
                const n = (p: (f: FieldRow) => boolean) => s.fields.filter(p).length
                return (
                  <button key={s.key} onClick={() => { setSection(s.key); setView('list') }} className="flex flex-col rounded-xl border border-line bg-surface p-3 text-left hover:border-brand-600/40">
                    <span className="flex items-start gap-2"><Icon name={s.icon ?? 'LayoutList'} className="mt-0.5 size-4 text-brand-700 dark:text-brand-300" />
                      <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-ink">{s.label}</span>{s.description && <span className="block text-xs text-ink-2">{s.description}</span>}</span>
                      <Badge tone="gray">{s.fields.length} fields</Badge></span>
                    <span className="mt-auto flex items-center gap-2 pt-3 text-xs font-semibold">
                      <span className="text-emerald-700 dark:text-emerald-400">V {n((f) => f.effective.visible)}</span>
                      <span className="text-amber-700 dark:text-amber-400">R {n((f) => f.effective.required)}</span>
                      <span className="text-sky-700 dark:text-sky-400">RO {n((f) => f.effective.readonly)}</span>
                      <span className="text-ink-3">H {n((f) => !f.effective.visible)}</span>
                      <ChevronRight className="ml-auto size-4 text-ink-3" />
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              {d.settings.length > 0 && !section && !status && (
                <ScreenSettings def={d} disabled={!d.can_edit || save.isPending} onChange={(settings) => save.mutate({ settings })} />
              )}
              <Card pad={false}>
                <div className="hidden grid-cols-[1fr_repeat(4,44px)_120px_64px_28px] items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 md:grid">
                  <span>Field</span><span className="text-center">Vis</span><span className="text-center">Req</span><span className="text-center">R/O</span><span className="text-center">Edit</span><span>Default</span><span className="text-center">Mask</span><span />
                </div>
                {filtered.length === 0 && <Empty icon="SearchX" title="No fields match" />}
                {filtered.map((f) => <FieldLine key={f.key} f={f} section={f.sectionLabel} disabled={!d.can_edit || save.isPending} onChange={(p) => setField(f.key, p)} />)}
              </Card>
            </>
          )}

          <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Quick tips</div>
            <div className="grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
              <Tip k="V" c="text-emerald-700 dark:text-emerald-400" t="Visible" d="Field is shown on the form" />
              <Tip k="R" c="text-amber-700 dark:text-amber-400" t="Required" d="Must be filled — checked by the server too" />
              <Tip k="RO" c="text-sky-700 dark:text-sky-400" t="Read only" d="Shown, cannot be typed into" />
              <Tip k="E" c="text-violet-700 dark:text-violet-400" t="Editable" d="Can be changed after the record is created" />
              <Tip k="H" c="text-ink-3" t="Hidden" d="Not shown; its default (if any) is still saved" />
              <Tip k="M" c="text-ink-2" t="Mask" d="Shows only the last 4 characters until revealed" />
            </div>
            <p className="mt-2 text-[11px] text-ink-3"><Lock className="mr-1 inline size-3" />Fields the system needs (e.g. patient name, mobile, bed) are always visible and required. A dot marks values set at this level; ↺ returns a field to the inherited value.</p>
          </div>
        </>
      )}
      {copyOpen && <CopyBranch form={form} formLabel={d?.label ?? form} to={scopeId ?? branch ?? ''} onClose={() => setCopyOpen(false)}
        onDone={() => { setCopyOpen(false); qc.invalidateQueries({ queryKey: ['fieldconfig'] }); qc.invalidateQueries({ queryKey: ['meta'] }) }} />}
    </div>
  )
}

function Tile({ icon, label, sub, value }: { icon: string; label: string; sub: string; value: number }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
      <Icon name={icon} className="size-4 text-ink-3" />
      <div className="min-w-0 flex-1 leading-tight"><div className="truncate text-xs font-medium text-ink">{label}</div><div className="text-[11px] text-ink-3">{sub}</div></div>
      <div className="text-xl font-semibold tabular-nums text-ink">{value}</div>
    </div>
  )
}

function Tip({ k, c, t, d }: { k: string; c: string; t: string; d: string }) {
  return <div className="flex gap-2"><span className={cn('w-5 font-bold', c)}>{k}</span><span><span className="font-medium text-ink">{t}</span><br /><span className="text-ink-3">{d}</span></span></div>
}

function FieldLine({ f, section, disabled, onChange }: { f: FieldRow; section: string; disabled: boolean; onChange: (p: Partial<Eff> | null) => void }) {
  const e = f.effective
  const [label, setLabel] = useState<string | null>(null)
  const [def, setDef] = useState<string | null>(null)
  const own = (k: keyof Eff) => k in f.override
  const dot = (k: keyof Eff) => own(k) ? <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-amber-500" title="Set at this level" /> : null
  const sw = (k: 'visible' | 'required' | 'readonly' | 'editable', lock: boolean) => (
    <span className="relative flex justify-center">
      <Switch size="sm" checked={!!e[k]} disabled={disabled || lock} label={`${k} ${e.label}`} onChange={(v) => onChange({ [k]: v })} />
      {dot(k)}
    </span>
  )
  const commitLabel = () => { if (label !== null && label.trim() !== e.label) onChange({ label: label.trim() || null } as Partial<Eff>); setLabel(null) }
  const commitDefault = () => { if (def !== null && def !== String(e.default ?? '')) onChange({ default: def === '' ? null : def } as Partial<Eff>); setDef(null) }
  return (
    <div className="grid grid-cols-2 items-center gap-2 border-b border-line px-3 py-2 last:border-0 hover:bg-surface-2 md:grid-cols-[1fr_repeat(4,44px)_120px_64px_28px]" title={`Field key: ${f.key}`}>
      <div className="col-span-2 min-w-0 md:col-span-1">
        {label !== null ? (
          <Input autoFocus className="h-7 text-sm" value={label} onChange={(ev) => setLabel(ev.target.value)} onBlur={commitLabel}
            onKeyDown={(ev) => { if (ev.key === 'Enter') commitLabel(); if (ev.key === 'Escape') setLabel(null) }} />
        ) : (
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-sm', e.visible ? 'text-ink' : 'text-ink-3 line-through decoration-ink-3/40')}>{e.label}</span>
            {own('label') && <span className="truncate text-[11px] text-ink-3">({f.label})</span>}
            {f.system_required && <span title="Needed by the system"><Lock className="size-3 text-ink-3" /></span>}
            <button type="button" disabled={disabled} onClick={() => setLabel(e.label)} className="rounded p-0.5 text-ink-3 hover:text-ink" aria-label={`Rename ${e.label}`}><Pencil className="size-3.5" /></button>
          </div>
        )}
        <div className="truncate text-[11px] text-ink-3">{section} · <span className="font-mono">{f.key}</span></div>
      </div>
      <div className="col-span-2 flex items-center gap-3 md:contents">
        <Lbl t="Vis">{sw('visible', f.system_required)}</Lbl>
        <Lbl t="Req">{sw('required', f.system_required || f.system_readonly || !e.visible)}</Lbl>
        <Lbl t="R/O">{sw('readonly', f.system_readonly || f.system_required)}</Lbl>
        <Lbl t="Edit">{sw('editable', f.system_readonly)}</Lbl>
        <span className="relative">
          <Input className="h-7 text-xs" placeholder="—" disabled={disabled || f.type === 'lines' || f.type === 'signature' || f.type === 'file'}
            value={def ?? (e.default === null || e.default === undefined ? '' : String(e.default))}
            onChange={(ev) => setDef(ev.target.value)} onBlur={commitDefault} onKeyDown={(ev) => { if (ev.key === 'Enter') commitDefault() }} aria-label={`Default for ${e.label}`} />
          {dot('default')}
        </span>
        <span className="relative flex justify-center">
          <button type="button" disabled={disabled} onClick={() => onChange({ mask: !e.mask })} aria-pressed={e.mask}
            className={cn('inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] ring-1 ring-inset', e.mask ? 'bg-brand-800 text-white ring-brand-800' : 'text-ink-2 ring-line-2 hover:bg-surface')}>
            {e.mask ? <EyeOff className="size-3" /> : <Eye className="size-3" />} {e.mask ? 'On' : 'Off'}
          </button>
          {dot('mask')}
        </span>
        <span className="flex justify-center">
          {Object.keys(f.override).length > 0 && (
            <button type="button" disabled={disabled} onClick={() => onChange(null)} className="rounded p-1 text-ink-3 hover:text-ink" title="Back to the inherited value" aria-label={`Reset ${e.label}`}>
              <RotateCcw className="size-3.5" />
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

function Lbl({ t, children }: { t: string; children: React.ReactNode }) {
  return <span className="flex flex-col items-center gap-0.5"><span className="text-[10px] text-ink-3 md:hidden">{t}</span>{children}</span>
}

export function ScreenSettings({ def, disabled, onChange }: { def: FormDef; disabled: boolean; onChange: (s: Record<string, unknown>) => void }) {
  const fieldOptions = def.sections.flatMap((s) => s.fields.filter((f) => f.effective.visible).map((f) => ({ value: f.key, label: f.effective.label })))
  return (
    <Card className="mb-3" pad={false}>
      <div className="border-b border-line px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{def.label} settings</div>
      {def.settings.map((s) => {
        const v = def.settings_values[s.key]
        const own = s.key in def.settings_override
        const opts = (s.type === 'field' ? fieldOptions : (s.options ?? []).map((o) => typeof o === 'string' ? { value: o, label: o } : o))
        return (
          <div key={s.key} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium text-ink">{s.label}{own && <span className="size-1.5 rounded-full bg-amber-500" title="Set at this level" />}</div>
              {s.help && <div className="text-xs text-ink-3">{s.help}</div>}
            </div>
            {s.type === 'boolean' && <Switch checked={!!v} disabled={disabled} label={s.label} onChange={(x) => onChange({ [s.key]: x })} />}
            {s.type === 'number' && <Input type="number" className="h-8 w-28" defaultValue={v as number} min={s.min} max={s.max} disabled={disabled}
              onBlur={(e) => e.target.value !== String(v ?? '') && onChange({ [s.key]: e.target.value === '' ? null : Number(e.target.value) })} />}
            {s.type === 'text' && <Input className="h-8 w-56" defaultValue={v as string} disabled={disabled} onBlur={(e) => e.target.value !== String(v ?? '') && onChange({ [s.key]: e.target.value || null })} />}
            {(s.type === 'select' || s.type === 'field') && (
              <Select className="h-8 w-56" value={String(v ?? '')} disabled={disabled} onChange={(e) => onChange({ [s.key]: e.target.value })}>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}{s.default === o.value ? ' (default)' : ''}</option>)}
              </Select>
            )}
            {s.type === 'multiselect' && (
              <div className="flex max-w-md flex-wrap justify-end gap-1">
                {opts.map((o) => {
                  const cur = (v as string[] | undefined) ?? []
                  const on = cur.includes(o.value)
                  return (
                    <button key={o.value} type="button" disabled={disabled} onClick={() => onChange({ [s.key]: on ? cur.filter((x) => x !== o.value) : [...cur, o.value] })}
                      className={cn('rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset', on ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
                      {o.label}
                    </button>
                  )
                })}
              </div>
            )}
            {own && <button type="button" disabled={disabled} onClick={() => onChange({ [s.key]: null })} className="rounded p-1 text-ink-3 hover:text-ink" title="Back to the inherited value"><RotateCcw className="size-3.5" /></button>}
          </div>
        )
      })}
    </Card>
  )
}

function CopyBranch({ form, formLabel, to, onClose, onDone }: { form: string; formLabel: string; to: string; onClose: () => void; onDone: () => void }) {
  const { branches } = useBranch()
  const others = branches.filter((b) => b.code !== to)
  const [from, setFrom] = useState(others[0]?.code ?? '')
  const [all, setAll] = useState(false)
  const copy = useMutation({
    mutationFn: () => api<{ copied: number }>('/fieldconfig/copy', { method: 'POST', body: { from_branch: from, to_branch: to, forms: all ? undefined : [form] } }),
    onSuccess: (r) => { toast.success(`Copied ${r.copied} configuration layer${r.copied === 1 ? '' : 's'}`); onDone() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Copy from branch" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!from} loading={copy.isPending} onClick={() => copy.mutate()}><Copy className="size-4" /> Copy</Button></>}>
      {others.length === 0 ? <p className="text-sm text-ink-2">There is only one branch. Add branches in Master Data › Branches.</p> : (
        <div className="space-y-3">
          <FieldWrap label="Copy from"><Select value={from} onChange={(e) => setFrom(e.target.value)}>{others.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</Select></FieldWrap>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-700" checked={all} onChange={(e) => setAll(e.target.checked)} /> Every form, not only “{formLabel}”</label>
          <p className="text-xs text-ink-3">The branch-level configuration of {branches.find((b) => b.code === to)?.name ?? to} is replaced. Organization, department and doctor levels are untouched.</p>
        </div>
      )}
    </Modal>
  )
}

