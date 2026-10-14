import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Eye, Gauge, Megaphone, Printer, Ticket, Tv } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { useMyEmployeeId } from '@/components/records'
import {
  Button, Card, cn, Empty, ErrorBox, FieldWrap, Kbd, Modal, Select, Spinner, StatTile, StatusBadge,
} from '@/components/ui'
import { useQueueAccess } from '@/features/queue/access'
import { TransferModal } from '@/features/queue/TransferModal'
import { PRIORITIES, type IssueResult, type QToken } from '@/features/queue/types'
import { PriorityBadge as Priority, printSlip, TokenStatus } from '@/features/queue/ui'
import { api, errorMessage } from '@/lib/api'
import { ago, minutes, time } from '@/lib/format'
import type { BespokeProps } from './index'

interface Stats { issued?: number; waiting?: number; in_service?: number; served?: number; skipped?: number; avg_wait_min?: number | null; avg_service_min?: number | null }
interface ConsoleState {
  queue: string; name: string; queue_name: string; counter: { id: string; name: string; status: string; location?: string } | null
  doctor?: { id: string; name: string } | null
  current: QToken | null; others: QToken[]; waiting: QToken[]; skipped: QToken[]; recent: QToken[]; stats: Stats
}
interface Queues {
  counters: ({ id: string; code: string; name: string; queue: string; type?: string; location?: string; status: string } & Stats)[]
  doctors: ({ queue: string; doctor_id: string; name: string; department?: string | null } & Stats)[]
}

const STORE = 'vlack.queue.target'
const readTarget = () => { try { return localStorage.getItem(STORE) } catch { return null } }
const saveTarget = (v: string) => { try { localStorage.setItem(STORE, v) } catch { /* storage unavailable */ } }
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)
const linkCls = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2'

/** `?queue=KEY` (from the Queue Monitor): an open counter serving that queue, else the cabin / whole line. */
function resolveQueueParam(key: string, queues: Queues): string {
  const cs = queues.counters.filter((c) => c.queue === key)
  const counter = cs.find((c) => c.status === 'Open') ?? cs[0]
  return counter ? `c:${counter.id}` : `q:${key}`
}

export default function QueueConsole({ module }: BespokeProps) {
  const qc = useQueryClient()
  const access = useQueueAccess()
  const myEmployeeId = useMyEmployeeId()
  const [params, setParams] = useSearchParams()
  const [target, setTarget] = useState<string | null>(readTarget)
  const [issuing, setIssuing] = useState(false)
  const [transferring, setTransferring] = useState<QToken | null>(null)
  const [slip, setSlip] = useState<IssueResult | null>(null)
  const canOperate = access.operate

  const queues = useQuery({ queryKey: ['x', module.id, 'queues'], queryFn: () => api<Queues>('/queue/queues'), refetchInterval: 60_000, enabled: access.console })
  // ?queue= from the Queue Monitor wins; otherwise keep a valid saved choice, else the doctor's own cabin, else the first open counter
  const wanted = params.get('queue')
  useEffect(() => {
    if (!queues.data) return
    if (wanted) {
      const next = resolveQueueParam(wanted.toUpperCase(), queues.data)
      setTarget(next)
      saveTarget(next)
      const p = new URLSearchParams(params)
      p.delete('queue')
      setParams(p, { replace: true })
      return
    }
    const valid = (t: string | null) => !!t && (t.startsWith('c:') ? queues.data!.counters.some((c) => `c:${c.id}` === t) : t.startsWith('q:') && t.length > 2)
    if (valid(target)) return
    const mine = queues.data.doctors.find((d) => d.doctor_id === myEmployeeId)
    const first = queues.data.counters.find((c) => c.status === 'Open') ?? queues.data.counters[0]
    const next = mine ? `q:${mine.queue}` : first ? `c:${first.id}` : null
    if (next) setTarget(next)
  }, [queues.data, target, myEmployeeId, wanted, params, setParams])

  const body = useMemo(() => (target?.startsWith('c:') ? { counter_id: target.slice(2) } : target ? { queue: target.slice(2) } : null), [target])
  const state = useQuery({
    queryKey: ['x', module.id, 'console', target],
    queryFn: () => api<ConsoleState>('/queue/console', { query: body ?? {} }),
    enabled: !!body && access.console && !wanted,
    refetchInterval: 20_000,
  })
  const s = state.data
  const cur = s?.current ?? null
  const refresh = () => qc.invalidateQueries({ queryKey: ['x', module.id] })
  /** A whole counter line (no counter chosen and no doctor): tokens can be watched but not called. */
  const lineOnly = !!s && !s.counter && !s.doctor
  const listed = !!target && (target.startsWith('c:') || !!queues.data?.doctors.some((d) => `q:${d.queue}` === target))

  const act = useMutation({
    mutationFn: ({ action, token }: { action: 'next' | 'call' | 'recall' | 'serve' | 'done' | 'skip'; token?: QToken }) =>
      action === 'next'
        ? api<{ token: QToken | null; message?: string }>('/queue/next', { method: 'POST', body })
        : api<{ token: QToken | null }>(`/queue/tokens/${token!.id}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: (r, { action }) => {
      if (!r.token) toast.info((r as { message?: string }).message ?? 'No one is waiting')
      else if (action === 'next' || action === 'call' || action === 'recall') toast.success(`${action === 'recall' ? 'Recalled' : 'Calling'} ${r.token.label}${r.token.patient ? ` — ${r.token.patient.name}` : ''}`)
      else if (action === 'skip') toast(`${r.token.label} is on hold — call it again from Held when the patient is back`)
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const counterState = useMutation({
    mutationFn: (open: boolean) => api(`/queue/counters/${s!.counter!.id}/state`, { method: 'POST', body: { open } }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['m', 'queue'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const closed = !!s?.counter && s.counter.status !== 'Open'
  const canCall = canOperate && !closed && !lineOnly

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canOperate || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || issuing || slip || transferring || act.isPending || !s) return
      const k = e.key.toLowerCase()
      if (k === 'n' && canCall) act.mutate({ action: 'next' })
      else if (cur && k === 'r' && cur.status === 'Called') act.mutate({ action: 'recall', token: cur })
      else if (cur && k === 's' && cur.status === 'Called') act.mutate({ action: 'serve', token: cur })
      else if (cur && k === 'd') act.mutate({ action: 'done', token: cur })
      else if (cur && k === 'k' && cur.status === 'Called') act.mutate({ action: 'skip', token: cur })
      else if (cur && k === 't') setTransferring(cur)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [act, cur, s, issuing, slip, transferring, canOperate, canCall])

  if (!access.ready) return <Spinner />
  if (!access.console) {
    return <Empty icon="Lock" title="The Counter Console needs access to queue tokens">Ask an administrator to give your role view or edit access to Queue Management › Tokens.</Empty>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={target ?? ''} onChange={(e) => { setTarget(e.target.value); saveTarget(e.target.value) }} className="h-9 w-80" aria-label="Counter or cabin">
          {!target && <option value="">Choose counter…</option>}
          <optgroup label="Counters">
            {queues.data?.counters.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>{c.name} · {c.queue}{c.status !== 'Open' ? ' (closed)' : ''}{c.waiting ? ` · ${c.waiting} waiting` : ''}</option>
            ))}
          </optgroup>
          <optgroup label="Doctor cabins (today)">
            {queues.data?.doctors.map((d) => (
              <option key={d.queue} value={`q:${d.queue}`}>{d.name}{d.department ? ` · ${d.department}` : ''}{d.waiting ? ` · ${d.waiting} waiting` : ''}</option>
            ))}
          </optgroup>
          {target && !listed && (
            <optgroup label="Other lines">
              <option value={target}>{s ? `${s.queue_name} · ${s.queue}` : target.slice(2)} (whole line)</option>
            </optgroup>
          )}
        </Select>
        {s?.counter && (
          <>
            <StatusBadge status={s.counter.status} />
            {access.counterState && (
              <Button size="sm" variant="ghost" loading={counterState.isPending} onClick={() => counterState.mutate(closed)}>{closed ? 'Open counter' : 'Close counter'}</Button>
            )}
          </>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {access.issue && <Button size="sm" icon="Ticket" onClick={() => setIssuing(true)} disabled={!s}>Issue token</Button>}
          {access.issue && <Link to="/queue/issue" className={linkCls} title="Full-screen token kiosk"><Ticket className="size-4" /> Kiosk</Link>}
          {access.monitor && <Link to="/queue/monitor" className={linkCls}><Gauge className="size-4" /> Queue Monitor</Link>}
          {access.display && <Link to="/m/queue/queue-display" className={linkCls}><Tv className="size-4" /> TV display</Link>}
        </div>
      </div>

      {!canOperate && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <Eye className="size-4 shrink-0" /> View only — your role can watch this queue but cannot call, hold or transfer tokens.
        </div>
      )}
      {queues.error && <ErrorBox error={queues.error} />}
      {state.error && <ErrorBox error={state.error} />}
      {!target && !queues.isLoading && <Empty icon="MonitorSpeaker" title="No counters configured">Add counters under Queue Management › Counters & Cabins.</Empty>}
      {state.isLoading && <Spinner />}

      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Waiting" value={s.waiting.length} icon="Users" tone={s.waiting.length > 15 ? 'alert' : 'default'} hint={s.skipped.length ? `${s.skipped.length} held` : undefined} />
            <StatTile label="At counters" value={(s.current ? 1 : 0) + s.others.length} icon="UserCheck" />
            <StatTile label="Served today" value={s.stats.served ?? 0} icon="CheckCircle2" hint={`${s.stats.issued ?? 0} issued`} />
            <StatTile label="Average wait" value={minutes(s.stats.avg_wait_min)} icon="Hourglass" hint="token → call" />
            <StatTile label="Average service" value={minutes(s.stats.avg_service_min)} icon="Timer" hint="call → done" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div className="space-y-4">
              <Card icon="Megaphone" title={<span>Now at <span className="text-ink-2">{s.name}</span></span>}
                actions={<span className="text-xs text-ink-3">{s.queue_name} · {s.queue}</span>}>
                {closed && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">This counter is closed. Open it to call tokens.</p>}
                {lineOnly && canOperate && (
                  <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                    You are viewing the whole {s.queue} line. Choose your counter above to call tokens
                    {queues.data && !queues.data.counters.some((c) => c.queue === s.queue) ? ` — no counter serves ${s.queue} yet; add one under Counters & Cabins with queue key ${s.queue}.` : '.'}
                  </p>
                )}
                {cur ? (
                  <div className="flex flex-wrap items-center gap-5">
                    <div className="rounded-2xl bg-brand-950 px-6 py-4 text-center text-white">
                      <div className="text-[11px] uppercase tracking-widest text-cyan-200/80">Token</div>
                      <div className="tabular text-5xl font-bold tracking-wider">{cur.label}</div>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2"><TokenStatus status={cur.status} /><Priority p={cur.priority} /></div>
                      {cur.patient ? (
                        <Link to={`/patients/${cur.patient_id}`} className="block truncate text-lg font-semibold text-brand-700 hover:underline dark:text-brand-300">{cur.patient.name}</Link>
                      ) : <div className="text-sm text-ink-3">Walk-in (no patient linked)</div>}
                      <div className="text-xs text-ink-2">{[cur.patient?.uhid, cur.patient?.age != null ? `${cur.patient.age}y ${cur.patient.gender?.[0] ?? ''}` : null].filter(Boolean).join(' · ')}</div>
                      <div className="text-xs text-ink-3">Called {ago(cur.called_at)}{cur.call_count && cur.call_count > 1 ? ` · called ${cur.call_count}×` : ''} · waited {minutes(cur.wait_min)}</div>
                    </div>
                  </div>
                ) : <Empty icon="Coffee" title="Counter is free">{canCall ? 'Call the next token when ready.' : undefined}</Empty>}
                {canOperate && (
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Button variant="primary" className="h-12 text-base sm:col-span-3" disabled={!canCall || act.isPending} loading={act.isPending && act.variables?.action === 'next'}
                      onClick={() => act.mutate({ action: 'next' })}>
                      <Megaphone className="size-5" /> Call next {s.waiting.length ? `(${s.waiting[0].label})` : ''} <Kbd>N</Kbd>
                    </Button>
                    <Button disabled={!cur || cur.status !== 'Called' || act.isPending} onClick={() => cur && act.mutate({ action: 'recall', token: cur })}>Recall <Kbd>R</Kbd></Button>
                    <Button disabled={!cur || cur.status !== 'Called' || act.isPending} onClick={() => cur && act.mutate({ action: 'serve', token: cur })}>Serving <Kbd>S</Kbd></Button>
                    <Button variant="success" disabled={!cur || act.isPending} onClick={() => cur && act.mutate({ action: 'done', token: cur })}>Done <Kbd>D</Kbd></Button>
                    <Button variant="ghost" disabled={!cur || cur.status !== 'Called' || act.isPending} onClick={() => cur && act.mutate({ action: 'skip', token: cur })}>Hold / not present <Kbd>K</Kbd></Button>
                    <Button variant="ghost" className="sm:col-span-2" disabled={!cur || act.isPending} onClick={() => cur && setTransferring(cur)}>
                      <ArrowRightLeft className="size-4" /> Transfer to another line <Kbd>T</Kbd>
                    </Button>
                  </div>
                )}
              </Card>
              {s.others.length > 0 && (
                <Card title="Other counters on this queue" pad={false}>
                  <ul className="divide-y divide-line text-sm">
                    {s.others.map((o) => (
                      <li key={o.id} className="flex items-center justify-between px-4 py-2">
                        <span className="tabular font-semibold">{o.label}</span>
                        <span className="text-ink-2">{o.counter_name}</span>
                        <TokenStatus status={o.status} />
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            <div className="space-y-4">
              <Card pad={false} icon="ListOrdered" title={`Waiting (${s.waiting.length})`} actions={<span className="text-xs text-ink-3">Emergency → senior / differently abled → token order</span>}>
                {s.waiting.length === 0 ? <Empty icon="Smile" title="No one is waiting" /> : (
                  <div className="max-h-[48vh] overflow-y-auto scroll-thin">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
                        <tr>{['#', 'Token', 'Patient', 'Priority', 'Waiting', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {s.waiting.map((t, i) => (
                          <tr key={t.id} className="border-b border-line last:border-0">
                            <td className="px-3 py-1.5 text-xs text-ink-3">{i + 1}</td>
                            <td className="tabular px-3 py-1.5 font-semibold">{t.label}</td>
                            <td className="px-3 py-1.5">{t.patient ? <><span className="text-ink">{t.patient.name}</span><span className="ml-1 text-xs text-ink-3">{t.patient.uhid}</span></> : <span className="text-ink-3">Walk-in</span>}</td>
                            <td className="px-3 py-1.5"><Priority p={t.priority} /></td>
                            <td className={cn('tabular px-3 py-1.5', (t.wait_min ?? 0) > 30 ? 'font-medium text-red-600' : 'text-ink-2')}>{minutes(t.wait_min)}</td>
                            <td className="px-3 py-1.5 text-right">
                              {canOperate && (
                                <span className="inline-flex items-center gap-1">
                                  <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => setTransferring(t)} title={`Transfer ${t.label} to another line`} aria-label={`Transfer ${t.label}`}>
                                    <ArrowRightLeft className="size-3.5" />
                                  </Button>
                                  <Button size="xs" variant="secondary" disabled={!canCall || act.isPending} onClick={() => act.mutate({ action: 'call', token: t })}>Call</Button>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              {s.skipped.length > 0 && (
                <Card pad={false} icon="PauseCircle" title={`Held (${s.skipped.length})`} actions={<span className="text-xs text-ink-3">Skipped — not present when called</span>}>
                  <ul className="divide-y divide-line text-sm">
                    {s.skipped.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 px-4 py-1.5">
                        <span className="tabular w-24 shrink-0 whitespace-nowrap font-semibold">{t.label}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-2">{t.patient?.name ?? 'Walk-in'}</span>
                        <TokenStatus status={t.status} />
                        {canOperate && (
                          <>
                            <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => setTransferring(t)}>Transfer</Button>
                            <Button size="xs" variant="ghost" disabled={!canCall || act.isPending} onClick={() => act.mutate({ action: 'call', token: t })}>Call again</Button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {s.recent.length > 0 && (
                <Card pad={false} icon="History" title="Recently served">
                  <ul className="divide-y divide-line text-sm">
                    {s.recent.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 px-4 py-1.5 text-ink-2">
                        <span className="tabular w-24 shrink-0 whitespace-nowrap font-medium text-ink">{t.label}</span>
                        <span className="min-w-0 flex-1 truncate">{t.patient?.name ?? 'Walk-in'}</span>
                        <span className="text-xs">{t.counter_name}</span>
                        <span className="tabular text-xs">{time(t.served_at)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      {issuing && s && <IssueModal queues={queues.data} defaultQueue={s.queue} onClose={() => setIssuing(false)}
        onIssued={(r) => { setIssuing(false); setSlip(r); refresh() }} />}
      {transferring && <TransferModal token={transferring} onClose={() => setTransferring(null)} onDone={refresh} />}
      {slip && (
        <Modal open onClose={() => setSlip(null)} size="sm" title="Token issued"
          footer={<>
            <Button variant="ghost" onClick={() => setSlip(null)}>Close</Button>
            <Button variant="primary" onClick={() => printSlip({ label: slip.token.label, queueName: slip.queue_name, hospital: slip.hospital, ahead: slip.ahead, priority: slip.token.priority })}>
              <Printer className="size-4" /> Print slip
            </Button>
          </>}>
          <div className="text-center">
            <div className="text-sm text-ink-2">{slip.queue_name}</div>
            <div className="tabular my-2 text-6xl font-bold tracking-wider text-ink">{slip.token.label}</div>
            <div className="text-sm text-ink-2">{slip.ahead} ahead · <Priority p={slip.token.priority} showNormal /></div>
            {slip.token.patient && <div className="mt-1 text-sm text-ink">{slip.token.patient.name} · {slip.token.patient.uhid}</div>}
          </div>
        </Modal>
      )}
    </div>
  )
}

function IssueModal({ queues, defaultQueue, onClose, onIssued }: {
  queues?: Queues; defaultQueue: string; onClose: () => void; onIssued: (r: IssueResult) => void
}) {
  const [queue, setQueue] = useState(defaultQueue)
  const [patientId, setPatientId] = useState<string | null>(null)
  const [priority, setPriority] = useState('')
  const keys = useMemo(() => {
    const seen = new Map<string, string>()
    queues?.counters.forEach((c) => { if (!seen.has(c.queue)) seen.set(c.queue, `${c.queue} — ${c.type ?? c.name}`) })
    queues?.doctors.forEach((d) => seen.set(d.queue, `${d.name}${d.department ? ` (${d.department})` : ''}`))
    if (!seen.has(defaultQueue)) seen.set(defaultQueue, defaultQueue)
    return [...seen.entries()]
  }, [queues, defaultQueue])
  const issue = useMutation({
    mutationFn: () => api<IssueResult>('/queue/tokens', {
      method: 'POST', body: { queue, patient_id: patientId, priority: priority || undefined },
    }),
    onSuccess: onIssued,
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Issue walk-in token" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="Ticket" loading={issue.isPending} onClick={() => issue.mutate()}>Issue token</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Queue" required>
          <Select value={queue} onChange={(e) => setQueue(e.target.value)}>{keys.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </FieldWrap>
        <FieldWrap label="Patient (optional)" help="Linking the UHID sends an SMS when the token is called.">
          <RefPicker refName="registration.patients" kind="patient" value={patientId} onChange={(id) => setPatientId(id)} placeholder="Search UHID / name / mobile" />
        </FieldWrap>
        <FieldWrap label="Priority" help="Blank = automatic (senior citizens from age / category). Emergency tokens skip the daily cap.">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Automatic</option>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </Select>
        </FieldWrap>
      </div>
    </Modal>
  )
}
