import { useQuery } from '@tanstack/react-query'
import { Bot, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { RefPicker } from '@/components/fields'
import { RecordDrawer, useEntity } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Select, Spinner, type BadgeTone } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, number } from '@/lib/format'
import type { ListResult, Rec } from '@/lib/types'
import type { BespokeProps } from './index'

interface Policy {
  id: string; code: string; status: string; risk_class?: string; ai_may?: string; review_required?: boolean; reviewer_roles?: string[]
  allowed_roles?: string[]; data_scope?: string[]; deidentify?: boolean; consent_required?: boolean; approved_models?: string[]
  retention_days?: number; review_due?: string
}
interface UseCase { use_case: string; policy: Policy | null; enabled: boolean; review_always: boolean }
interface UseCases { use_cases: UseCase[]; llm: { configured: boolean; model: string } }
type AuditResult = ListResult & { stats_30d: Record<string, Record<string, number>> }

const EVENTS = ['Generated', 'Viewed', 'Edited', 'Approved', 'Rejected', 'Auto-applied', 'Blocked by policy', 'Overridden']
const EVENT_TONE: Record<string, BadgeTone> = {
  Generated: 'violet', Viewed: 'gray', Edited: 'blue', Approved: 'green', Rejected: 'red', 'Auto-applied': 'cyan',
  'Blocked by policy': 'red', Overridden: 'amber',
}
const RISK_TONE: Record<string, BadgeTone> = { Low: 'green', Medium: 'amber', High: 'red', Prohibited: 'red' }
const LIMIT = 50

function PolicyCard({ uc, stats }: { uc: UseCase; stats?: Record<string, number> }) {
  const p = uc.policy
  const review = !!p && (p.review_required || uc.review_always)
  const total = Object.values(stats ?? {}).reduce((a, b) => a + b, 0)
  return (
    <section className={cn('flex flex-col rounded-xl border bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)]', uc.enabled ? 'border-line' : 'border-red-300 dark:border-red-500/40')}>
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{uc.use_case}</h3>
        {p ? <Badge tone={RISK_TONE[p.risk_class ?? ''] ?? 'gray'}>{p.risk_class ?? '—'} risk</Badge> : <Badge tone="red">No policy</Badge>}
      </header>
      {p ? (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-3">Status</dt>
          <dd>{uc.enabled ? <Badge tone="green" dot>Active</Badge> : <Badge tone="red" dot>{p.status === 'Active' ? 'Prohibited' : p.status}</Badge>} <span className="font-mono text-ink-3">{p.code}</span></dd>
          <dt className="text-ink-3">AI may</dt>
          <dd className="text-ink">{p.ai_may ?? '—'}</dd>
          <dt className="text-ink-3">Human review</dt>
          <dd className="text-ink">{review ? 'Mandatory' : 'Not required (auto-apply, audited)'}{uc.review_always && !p.review_required ? ' — enforced for clinical use' : ''}</dd>
          <dt className="text-ink-3">Reviewers</dt>
          <dd className="text-ink">{p.reviewer_roles?.join(', ') || 'Any AI-module role'}</dd>
          <dt className="text-ink-3">Who may run</dt>
          <dd className="text-ink">{p.allowed_roles?.join(', ') || 'AI-module roles'}</dd>
          <dt className="text-ink-3">Data scope</dt>
          <dd className="flex flex-wrap gap-1">{(p.data_scope ?? []).map((s) => <Badge key={s} tone="gray">{s}</Badge>)}{!p.data_scope?.length && <span className="text-ink-3">Unrestricted</span>}</dd>
          <dt className="text-ink-3">Privacy</dt>
          <dd className="text-ink">{p.deidentify !== false ? 'Identifiers masked' : 'Identifiers not masked'}{p.consent_required ? ' · consent required' : ''}</dd>
          {!!p.approved_models?.length && <><dt className="text-ink-3">Models</dt><dd className="text-ink">{p.approved_models.join(', ')}</dd></>}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-ink-2">Blocked until Quality defines a policy for this use case.</p>
      )}
      <footer className="mt-auto flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-ink-2">
        <span className="tabular">{number(total)} events · 30 d</span>
        {(['Generated', 'Approved', 'Rejected', 'Blocked by policy'] as const).map((e) => stats?.[e] ? <span key={e} className="tabular">{e}: {stats[e]}</span> : null)}
      </footer>
    </section>
  )
}

export default function AiAudit(_: BespokeProps) {
  const entity = useEntity('aigov.audit_log')
  const [useCase, setUseCase] = useState('')
  const [event, setEvent] = useState('')
  const [actor, setActor] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => setPage(1), [useCase, event, actor, from, to])

  const cases = useQuery({ queryKey: ['x', 'aigov', 'use-cases'], queryFn: () => api<UseCases>('/ai/use-cases'), staleTime: 60_000 })
  const query = { use_case: useCase || undefined, event: event || undefined, actor: actor ?? undefined, date_from: from || undefined, date_to: to || undefined, page, limit: LIMIT }
  const log = useQuery({
    queryKey: ['x', 'aigov', 'audit', query],
    queryFn: () => api<AuditResult>('/ai/audit', { query }),
    placeholderData: (p) => p,
  })
  const rows = log.data?.rows ?? []
  const pages = Math.max(1, Math.ceil((log.data?.total ?? 0) / LIMIT))
  const blocked = useMemo(() => Object.values(log.data?.stats_30d ?? {}).reduce((a, s) => a + (s['Blocked by policy'] ?? 0), 0), [log.data])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <span>Drafting engine:</span>
        {cases.data?.llm.configured
          ? <Badge tone="violet"><Sparkles className="size-3" /> {cases.data.llm.model}</Badge>
          : <Badge tone="gray"><Bot className="size-3" /> Rule-based (no LLM key configured)</Badge>}
        {blocked > 0 && <Badge tone="red">{blocked} policy blocks in 30 days</Badge>}
        <Link to="/m/aigov/policies" className="ml-auto text-brand-700 hover:underline dark:text-brand-300">Edit policies →</Link>
      </div>

      {cases.error && <ErrorBox error={cases.error} />}
      {cases.isLoading ? <Spinner /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cases.data?.use_cases.map((uc) => <PolicyCard key={uc.use_case} uc={uc} stats={log.data?.stats_30d[uc.use_case]} />)}
        </div>
      )}

      <Card pad={false} title="AI audit log" icon="ScrollText">
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2 lg:grid-cols-5">
          <FieldWrap label="Use case">
            <Select value={useCase} onChange={(e) => setUseCase(e.target.value)}>
              <option value="">All</option>
              {(cases.data?.use_cases ?? []).map((u) => <option key={u.use_case}>{u.use_case}</option>)}
            </Select>
          </FieldWrap>
          <FieldWrap label="Decision / event">
            <Select value={event} onChange={(e) => setEvent(e.target.value)}>
              <option value="">All</option>
              {EVENTS.map((e) => <option key={e}>{e}</option>)}
            </Select>
          </FieldWrap>
          <FieldWrap label="User">
            <RefPicker refName="employees.employees" value={actor} onChange={(id) => setActor(id)} placeholder="Any user" />
          </FieldWrap>
          <FieldWrap label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></FieldWrap>
          <FieldWrap label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></FieldWrap>
        </div>
        {log.error && <div className="p-4"><ErrorBox error={log.error} /></div>}
        {log.isLoading && <Spinner />}
        {log.data && !rows.length && <Empty icon="ScrollText" title="No AI events match these filters" />}
        {!!rows.length && (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>{['When', 'Event', 'Use case', 'User', 'Patient', 'Model', 'Risk', 'Usage', 'Detail'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className={cn(log.isFetching && 'opacity-70')}>
                {rows.map((r: Rec) => (
                  <tr key={r.id} onClick={() => setOpen(r.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">{dateTime(r.occurred_at ?? r.created_at)}</td>
                    <td className="px-3 py-2"><Badge tone={EVENT_TONE[r.event] ?? 'gray'}>{r.event}</Badge></td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink">{r.use_case}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">{r.actor ? log.data!.refs[r.actor] ?? '…' : 'System'}{r.actor_role ? <span className="text-ink-3"> · {r.actor_role}</span> : null}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2">{r.patient_id
                      ? <Link onClick={(e) => e.stopPropagation()} to={`/patients/${r.patient_id}`} className="text-brand-700 hover:underline dark:text-brand-300">{log.data!.refs[r.patient_id] ?? '…'}</Link>
                      : <span className="text-ink-3">—</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{r.model ?? '—'}</td>
                    <td className="px-3 py-2">{r.risk_class ? <Badge tone={RISK_TONE[r.risk_class] ?? 'gray'}>{r.risk_class}</Badge> : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs tabular text-ink-2">
                      {r.tokens_in != null ? `${number(r.tokens_in)} → ${number(r.tokens_out)} tok · ${number(r.latency_ms)} ms` : '—'}
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-xs text-ink-2" title={r.output_excerpt}>{r.output_excerpt ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.data && log.data.total > LIMIT && (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-2">
            <span className="tabular">{(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, log.data.total)} of {log.data.total}</span>
            <div className="flex items-center gap-1">
              <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
              <span className="tabular">Page {page} / {pages}</span>
              <Button size="xs" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
            </div>
          </div>
        )}
      </Card>
      {open && entity && <RecordDrawer entity={entity} id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
