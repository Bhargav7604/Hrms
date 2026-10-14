import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, ShieldAlert, Sparkles } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import {
  Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Segmented, Select, Spinner, StatusBadge, Textarea, type BadgeTone,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, dateTime, todayISO } from '@/lib/format'
import type { ListResult, Rec } from '@/lib/types'
import type { BespokeProps } from './index'

// ------------------------------------------------------------------ types

interface Policy {
  id: string; code: string; status: string; risk_class?: string; ai_may?: string; review_required?: boolean
  reviewer_roles?: string[]; allowed_roles?: string[]; data_scope?: string[]; deidentify?: boolean; consent_required?: boolean
  approved_models?: string[]
}
interface UseCase { use_case: string; policy: Policy | null; enabled: boolean; can_invoke: boolean; can_review: boolean; review_always: boolean }
interface UseCases { use_cases: UseCase[]; llm: { configured: boolean; model: string } }
type Draft = Rec & {
  draft_type: string; source?: 'LLM' | 'Rule-based'; model?: string; content?: string; context_summary?: string; target?: string
  confidence?: number; review_notes?: string; reviewed_at?: string; applied_target?: string | null; notice?: string | null
  context?: unknown; output?: Record<string, unknown>; generated_text?: string; data_categories?: string[]
}
interface DraftDetail { draft: Draft; policy: Policy | null; can_review: boolean }
interface RunResult { draft: Draft; applied: string | null; review_required: boolean; notice: string | null }

type InputKind = 'patient' | 'encounter' | 'ward' | 'range' | 'none'
const UC: Record<string, { icon: string; input: InputKind; hint: string; path: (a: Args) => string; days?: number }> = {
  'Patient Summary': { icon: 'UserRound', input: 'patient', hint: 'Changes in the last 24 h: vitals trend, new and critical results, orders, medicines, notes.', path: (a) => `/ai/patients/${a.patient}/summary` },
  'Progress Note': { icon: 'NotebookPen', input: 'encounter', hint: 'SOAP note drafted from data since the last signed progress note. Saved as a Draft note on approval.', path: (a) => `/ai/encounters/${a.encounter}/progress-note` },
  'Discharge Summary': { icon: 'LogOut', input: 'encounter', hint: 'NABH-style summary from notes, results, procedures and active prescriptions. Creates / updates the Draft discharge summary on approval.', path: (a) => `/ai/encounters/${a.encounter}/discharge-summary` },
  'Task Prioritisation': { icon: 'ListOrdered', input: 'ward', hint: 'Ranks critical results, deterioration (NEWS2), due medicines, overdue vitals and pending samples for a ward.', path: (a) => `/ai/wards/${a.ward}/prioritise` },
  'TAT Bottlenecks': { icon: 'Timer', input: 'range', days: 7, hint: 'Lab / radiology stage TAT, ER door-to-doctor, OPD wait and discharge TAT against targets.', path: () => '/ai/ops/tat' },
  'Anomaly Alert': { icon: 'Activity', input: 'none', hint: 'Revenue and collection dips vs a 14-day same-time baseline, discounts, refunds, unbilled leakage, occupancy.', path: () => '/ai/ops/anomalies' },
  'Feedback Themes': { icon: 'MessagesSquare', input: 'range', days: 30, hint: 'Clusters patient feedback into themes with sentiment and writes them back to the feedback records.', path: () => '/ai/feedback/themes' },
}
interface Args { patient?: string | null; encounter?: string | null; ward?: string | null; from?: string; to?: string }

const RISK_TONE: Record<string, BadgeTone> = { Low: 'green', Medium: 'amber', High: 'red', Prohibited: 'red' }

function shiftDays(iso: string, d: number) {
  const x = new Date(`${iso}T00:00:00`)
  x.setDate(x.getDate() + d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

// ------------------------------------------------------------------ context viewer (what the AI saw)

function Scalar({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === '') return <span className="text-ink-3">—</span>
  if (typeof v === 'boolean') return <>{v ? 'Yes' : 'No'}</>
  if (typeof v === 'number') return <span className="tabular">{Number.isInteger(v) ? v : v.toFixed(1)}</span>
  return <>{String(v)}</>
}

function ContextView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined || typeof value !== 'object') return <Scalar v={value} />
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-ink-3">none</span>
    if (value.every((x) => x === null || typeof x !== 'object')) return <span>{value.map((x) => String(x)).join(', ')}</span>
    if (value.every((x) => Array.isArray(x))) return <span>{value.map((x) => (x as unknown[]).join(' ')).join(' · ')}</span>
    const keys = Array.from(new Set(value.flatMap((x) => (x && typeof x === 'object' ? Object.keys(x) : [])))).slice(0, 7)
    return (
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-[11px]">
          <thead className="bg-surface-2 text-ink-2"><tr>{keys.map((k) => <th key={k} className="px-1.5 py-1 text-left font-medium">{humanize(k)}</th>)}</tr></thead>
          <tbody>
            {value.slice(0, 40).map((row, i) => (
              <tr key={i} className="border-t border-line align-top">
                {keys.map((k) => {
                  const c = (row as Record<string, unknown>)[k]
                  return <td key={k} className="px-1.5 py-1">{c && typeof c === 'object' ? <ContextView value={c} depth={depth + 1} /> : <Scalar v={c} />}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {value.length > 40 && <p className="px-2 py-1 text-[11px] text-ink-3">… {value.length - 40} more</p>}
      </div>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return <span className="text-ink-3">—</span>
  return (
    <dl className={cn('grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-1', depth > 0 && 'text-[11px]')}>
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-ink-3">{humanize(k)}</dt>
          <dd className="min-w-0 break-words text-ink"><ContextView value={v} depth={depth + 1} /></dd>
        </Fragment>
      ))}
    </dl>
  )
}

// ------------------------------------------------------------------ small pieces

function SourceBadge({ d }: { d: Pick<Draft, 'source' | 'model'> }) {
  return d.source === 'LLM'
    ? <Badge tone="violet"><Sparkles className="size-3" /> LLM · {d.model}</Badge>
    : <Badge tone="gray"><Bot className="size-3" /> Rule-based</Badge>
}

function targetLink(t?: string | null): { to: string; label: string } | null {
  if (!t) return null
  const m = t.match(/^([a-z_]+)\.([a-z_]+):([0-9a-f-]{36})$/)
  if (m) {
    if (m[1] === 'registration' && m[2] === 'patients') return { to: `/patients/${m[3]}`, label: 'Open patient' }
    return { to: `/m/${m[1]}/${m[2]}?r=${m[3]}`, label: `Open ${humanize(m[2]).replace(/s$/, '')}` }
  }
  const e = t.match(/^([a-z_]+)\.([a-z_]+)/)
  return e ? { to: `/m/${e[1]}/${e[2]}`, label: t } : null
}

function PolicyChips({ uc }: { uc?: UseCase }) {
  const p = uc?.policy
  if (!p) return <Badge tone="red">No policy — blocked</Badge>
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone={RISK_TONE[p.risk_class ?? ''] ?? 'gray'}>Risk: {p.risk_class ?? '—'}</Badge>
      <Badge tone="blue">AI may: {p.ai_may ?? '—'}</Badge>
      <Badge tone={p.review_required || uc?.review_always ? 'amber' : 'gray'}>
        {p.review_required || uc?.review_always ? 'Human review mandatory' : 'Auto-apply with audit'}
      </Badge>
      {p.deidentify !== false && <Badge tone="cyan">De-identified</Badge>}
      {p.status !== 'Active' && <Badge tone="red">Policy {p.status}</Badge>}
    </div>
  )
}

// ------------------------------------------------------------------ run panel

function RunPanel({ cases, onRan }: { cases: UseCase[]; onRan: (d: Draft) => void }) {
  const usable = cases.filter((c) => c.can_invoke)
  const [uc, setUc] = useState<string>(usable[0]?.use_case ?? 'Patient Summary')
  const [args, setArgs] = useState<Args>({ to: todayISO() })
  const cfg = UC[uc]
  const meta = cases.find((c) => c.use_case === uc)
  const encs = useQuery({
    queryKey: ['x', 'ai', 'encounters', args.patient],
    queryFn: () => api<ListResult>('/m/ipd/encounters', { query: { patient_id: args.patient!, limit: 10, sort: '-started_at' } }),
    enabled: !!args.patient && cfg.input === 'encounter',
  })
  useEffect(() => {
    const first = encs.data?.rows.find((r) => ['Admitted', 'Discharge Initiated', 'In Treatment', 'Observation', 'Open'].includes(r.status ?? '')) ?? encs.data?.rows[0]
    setArgs((a) => ({ ...a, encounter: first?.id ?? null }))
  }, [encs.data])
  const run = useMutation({
    mutationFn: () => {
      const from = args.from || shiftDays(args.to || todayISO(), -((cfg.days ?? 7) - 1))
      const body = cfg.input === 'range' ? { from, to: args.to || todayISO() } : undefined
      return api<RunResult>(cfg.path(args), { method: 'POST', body })
    },
    onSuccess: (r) => {
      toast.success(r.review_required ? `${r.draft.code} drafted — waiting for review` : `${r.draft.code} applied under policy (audited)`)
      if (r.notice) toast.info(r.notice)
      onRan(r.draft)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const ready = cfg.input === 'patient' ? !!args.patient : cfg.input === 'encounter' ? !!args.encounter : cfg.input === 'ward' ? !!args.ward : true

  return (
    <Card title="Run a use case" icon="Sparkles">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {cases.map((c) => (
            <button key={c.use_case} type="button" disabled={!c.can_invoke} onClick={() => setUc(c.use_case)}
              title={c.can_invoke ? undefined : 'Your role may not invoke this use case'}
              className={cn('rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                uc === c.use_case ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
              {c.use_case}{!c.enabled && ' (off)'}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-2">{cfg.hint}</p>
        <PolicyChips uc={meta} />
        {(cfg.input === 'patient' || cfg.input === 'encounter') && (
          <FieldWrap label="Patient" required>
            <RefPicker refName="registration.patients" kind="patient" value={args.patient} placeholder="Name, UHID or mobile…"
              onChange={(id) => setArgs((a) => ({ ...a, patient: id, encounter: null }))} />
          </FieldWrap>
        )}
        {cfg.input === 'encounter' && args.patient && (
          <FieldWrap label="Encounter" required help={encs.data && !encs.data.rows.length ? 'This patient has no encounters' : undefined}>
            <Select value={args.encounter ?? ''} onChange={(e) => setArgs((a) => ({ ...a, encounter: e.target.value || null }))}>
              <option value="">Select…</option>
              {encs.data?.rows.map((r) => (
                <option key={r.id} value={r.id}>{r.code} · {r.type} · {r.status} · {dateTime(r.started_at)}</option>
              ))}
            </Select>
          </FieldWrap>
        )}
        {cfg.input === 'ward' && (
          <FieldWrap label="Ward" required>
            <RefPicker refName="mdm.wards" value={args.ward} placeholder="Choose a ward…" onChange={(id) => setArgs((a) => ({ ...a, ward: id }))} />
          </FieldWrap>
        )}
        {cfg.input === 'range' && (
          <div className="grid grid-cols-2 gap-2">
            <FieldWrap label="From" help={`Default: last ${cfg.days} days`}>
              <Input type="date" value={args.from ?? ''} max={args.to} onChange={(e) => setArgs((a) => ({ ...a, from: e.target.value }))} />
            </FieldWrap>
            <FieldWrap label="To">
              <Input type="date" value={args.to ?? ''} max={todayISO()} onChange={(e) => setArgs((a) => ({ ...a, to: e.target.value }))} />
            </FieldWrap>
          </div>
        )}
        <Button variant="primary" icon="Sparkles" className="w-full" disabled={!ready || !meta?.can_invoke || !meta?.enabled}
          loading={run.isPending} onClick={() => run.mutate()}>
          Generate draft
        </Button>
        {meta && !meta.enabled && <p className="text-xs text-red-600">This use case is disabled by AI governance.</p>}
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ structured output preview

function OutputView({ d }: { d: Draft }) {
  const out = d.output ?? {}
  const tasks = out.tasks as Rec[] | undefined
  const findings = out.findings as Rec[] | undefined
  const themes = out.themes as Rec[] | undefined
  if (tasks?.length) {
    return (
      <ol className="space-y-1 text-xs">
        {tasks.slice(0, 25).map((t, i) => (
          <li key={i} className="flex gap-2">
            <Badge tone={String(t.priority).startsWith('P1') ? 'red' : String(t.priority).startsWith('P2') ? 'amber' : 'gray'}>{t.priority}</Badge>
            <span className="min-w-0"><span className="font-medium text-ink">Bed {t.bed ?? '—'}</span> — {t.task} <span className="text-ink-3">({t.reason})</span></span>
          </li>
        ))}
      </ol>
    )
  }
  if (findings?.length) {
    return (
      <ul className="space-y-1.5 text-xs">
        {findings.map((f, i) => (
          <li key={i} className="flex gap-2">
            <Badge tone={f.severity === 'High' ? 'red' : f.severity === 'Medium' ? 'amber' : 'gray'}>{f.severity}</Badge>
            <span><span className="font-medium text-ink">{f.headline}</span> <span className="text-ink-3">· {f.area}</span></span>
          </li>
        ))}
      </ul>
    )
  }
  if (themes?.length) {
    return (
      <ul className="space-y-1 text-xs">
        {themes.map((t, i) => (
          <li key={i}><span className="font-medium text-ink">{t.theme}</span> — {t.mentions} mentions, {t.negative_share}% negative</li>
        ))}
      </ul>
    )
  }
  return null
}

// ------------------------------------------------------------------ review panel

function ReviewPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const q = useQuery({ queryKey: ['x', 'ai', 'draft', id], queryFn: () => api<DraftDetail>(`/ai/drafts/${id}`) })
  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')
  const [view, setView] = useState<'context' | 'output' | 'original'>('context')
  useEffect(() => { if (q.data) { setText(q.data.draft.content ?? ''); setNotes('') } }, [q.data])
  const review = useMutation({
    mutationFn: (approve: boolean) => api<{ draft: Draft; applied: string | null }>(`/ai/drafts/${id}/review`, {
      method: 'POST', body: { approve, edited_content: approve ? text : undefined, notes: notes || undefined },
    }),
    onSuccess: (r, approve) => {
      toast.success(approve ? `Approved${r.applied ? ` → ${r.applied.split(':')[0]}` : ''}` : 'Draft rejected')
      qc.invalidateQueries({ queryKey: ['x', 'ai'] })
      qc.invalidateQueries({ queryKey: ['stats', 'ai'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <Card><Spinner label="Loading draft…" /></Card>
  if (q.error) return <Card><ErrorBox error={q.error} /></Card>
  const { draft: d, policy, can_review } = q.data!
  const pending = d.status === 'Pending Review'
  const edited = pending && text.trim() !== (d.content ?? '').trim()
  const link = targetLink(d.applied_target ?? d.target)
  const hasOutput = !!(d.output && ((d.output.tasks as unknown[])?.length || (d.output.findings as unknown[])?.length || (d.output.themes as unknown[])?.length))
  return (
    <Card pad={false} title={<span className="flex flex-wrap items-center gap-2">{d.draft_type} <span className="font-mono text-xs text-ink-3">{d.code}</span> <StatusBadge status={d.status} /></span>}
      actions={<Button size="xs" variant="ghost" icon="X" onClick={onClose}>Close</Button>}>
      <div className="flex items-start gap-2 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <span><b>AI draft — requires clinician review.</b> Verify every statement against the record before approving. Nothing is written to the
          chart until a {(policy?.reviewer_roles ?? []).join(' / ') || 'reviewer'} approves it.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-ink-2">
        <SourceBadge d={d} />
        {d.confidence != null && <Badge tone="gray">Data completeness {d.confidence}%</Badge>}
        {d.patient_id && <Link to={`/patients/${d.patient_id}`} className="text-brand-700 hover:underline dark:text-brand-300">{d._refs?.[d.patient_id] ?? 'Patient'}</Link>}
        <span>Generated {ago(d.created_at)}</span>
        {d.notice && <Badge tone="amber">{d.notice}</Badge>}
      </div>
      <div className="grid gap-0 border-t border-line lg:grid-cols-2">
        <section className="min-w-0 border-b border-line p-4 lg:border-b-0 lg:border-r">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">What the AI used</h4>
            <Segmented value={view} onChange={setView} options={[
              { key: 'context', label: 'Data' },
              ...(hasOutput ? [{ key: 'output' as const, label: 'Structured' }] : []),
              { key: 'original', label: 'Original' },
            ]} />
          </div>
          <p className="mb-2 text-xs text-ink-2">{d.context_summary}{d.data_categories?.length ? ` · scope: ${d.data_categories.join(', ')}` : ''}</p>
          <div className="max-h-[56vh] overflow-y-auto pr-1 text-xs scroll-thin">
            {view === 'context' && <ContextView value={d.context} />}
            {view === 'output' && <OutputView d={d} />}
            {view === 'original' && <pre className="whitespace-pre-wrap font-sans text-xs text-ink-2">{d.generated_text ?? d.content}</pre>}
          </div>
        </section>
        <section className="min-w-0 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Draft {edited && <Badge tone="blue">Edited</Badge>}</h4>
            {pending && edited && <Button size="xs" variant="ghost" onClick={() => setText(d.content ?? '')}>Undo edits</Button>}
          </div>
          {pending && can_review ? (
            <Textarea rows={18} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs leading-relaxed"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') review.mutate(true) }} aria-label="Draft text" />
          ) : (
            <pre className="max-h-[56vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink scroll-thin">{d.content}</pre>
          )}
          {pending && can_review && (
            <div className="mt-3 space-y-2">
              <FieldWrap label="Review notes" help="Required when rejecting; saved to the AI audit log">
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Checked against chart; corrected medication list" />
              </FieldWrap>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="danger" icon="X" loading={review.isPending && review.variables === false}
                  onClick={() => { if (!notes.trim()) { toast.error('Give a reason when rejecting'); return } review.mutate(false) }}>Reject</Button>
                <Button variant="success" icon="Check" loading={review.isPending && review.variables === true} onClick={() => review.mutate(true)}>
                  Approve{edited ? ' with edits' : ''}
                </Button>
              </div>
              <p className="text-right text-[11px] text-ink-3">Ctrl / ⌘ + Enter approves · signed in as {user?.name}</p>
            </div>
          )}
          {pending && !can_review && (
            <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
              Waiting for review by {(policy?.reviewer_roles ?? []).join(' / ')}. Your role can read but not approve this draft.
            </p>
          )}
          {!pending && (
            <div className="mt-3 space-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
              <div>{d.status} {d.reviewed_at ? dateTime(d.reviewed_at) : ''}{d._refs?.[d.reviewer] ? ` by ${d._refs[d.reviewer]}` : ''}</div>
              {d.review_notes && <div className="italic">“{d.review_notes}”</div>}
              {d.applied_target && <div>Applied to <span className="font-mono">{d.applied_target}</span></div>}
              {link && d.status === 'Approved' && <Link to={link.to} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{link.label} →</Link>}
            </div>
          )}
        </section>
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ page

type StatusFilter = 'Pending Review' | 'Approved' | 'Rejected' | 'all'

export default function AiConsole(_: BespokeProps) {
  const [status, setStatus] = useState<StatusFilter>('Pending Review')
  const [type, setType] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const cases = useQuery({ queryKey: ['x', 'ai', 'use-cases'], queryFn: () => api<UseCases>('/ai/use-cases'), staleTime: 60_000 })
  const query = { status: status === 'all' ? undefined : status, draft_type: type || undefined, limit: 50 }
  const drafts = useQuery({
    queryKey: ['x', 'ai', 'drafts', query],
    queryFn: () => api<ListResult>('/ai/drafts', { query }),
    placeholderData: (p) => p,
  })
  const rows = (drafts.data?.rows ?? []) as Draft[]
  const llm = cases.data?.llm
  const typeOptions = useMemo(() => Object.keys(UC), [])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
        <ShieldAlert className="size-4 text-amber-600" />
        <span className="text-ink">Every AI output is a <b>draft</b>. Clinical drafts are never written to the record without review.</span>
        <span className="ml-auto">{llm && (llm.configured
          ? <Badge tone="violet"><Sparkles className="size-3" /> LLM drafting · {llm.model}</Badge>
          : <Badge tone="gray"><Bot className="size-3" /> Rule-based drafting (no LLM configured)</Badge>)}</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          {cases.isLoading && <Card><Spinner /></Card>}
          {cases.error && <ErrorBox error={cases.error} />}
          {cases.data && <RunPanel cases={cases.data.use_cases} onRan={(d) => { setStatus(d.status === 'Approved' ? 'Approved' : 'Pending Review'); setOpen(d.id) }} />}
        </div>
        <div className="min-w-0 space-y-4">
          {open && <ReviewPanel key={open} id={open} onClose={() => setOpen(null)} />}
          <Card pad={false} title="Draft queue" icon="Inbox"
            actions={<>
              <Select value={type} onChange={(e) => setType(e.target.value)} className="h-8 w-44 text-xs" aria-label="Use case">
                <option value="">All use cases</option>
                {typeOptions.map((t) => <option key={t}>{t}</option>)}
              </Select>
              <Segmented value={status} onChange={setStatus} options={[
                { key: 'Pending Review', label: 'Pending' }, { key: 'Approved', label: 'Approved' }, { key: 'Rejected', label: 'Rejected' }, { key: 'all', label: 'All' },
              ]} />
            </>}>
            {drafts.error && <div className="p-4"><ErrorBox error={drafts.error} /></div>}
            {drafts.isLoading && <Spinner />}
            {drafts.data && !rows.length && (
              <Empty icon="Sparkles" title={status === 'Pending Review' ? 'Nothing waiting for review' : 'No drafts'}>
                Run a use case on the left to generate a draft.
              </Empty>
            )}
            {!!rows.length && (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                    <tr>{['Draft', 'Use case', 'Patient', 'Source', 'Generated', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
                  </thead>
                  <tbody className={cn(drafts.isFetching && 'opacity-70')}>
                    {rows.map((d) => (
                      <tr key={d.id} onClick={() => setOpen(d.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(d.id) }}
                        className={cn('cursor-pointer border-b border-line last:border-0 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none', open === d.id && 'bg-brand-50/60 dark:bg-brand-500/10')}>
                        <td className="px-3 py-2 font-mono text-xs text-ink-2">{d.code}</td>
                        <td className="px-3 py-2 text-ink">{d.draft_type}</td>
                        <td className="max-w-[14rem] truncate px-3 py-2 text-ink-2">{d.patient_id ? drafts.data!.refs[d.patient_id] ?? '…' : <span className="text-ink-3">—</span>}</td>
                        <td className="px-3 py-2"><SourceBadge d={d} /></td>
                        <td className="whitespace-nowrap px-3 py-2 text-ink-2">{ago(d.created_at)}</td>
                        <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
