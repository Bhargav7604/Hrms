import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, ChevronDown, Lock } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, cn, ErrorBox, FieldWrap, Input, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { date, dateTime, money } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K, type DischargeData, type DischargeType, type PrintFormat } from './api'
import { DocumentsModal } from './DischargeDocs'
import { Copyable, KeyHints, newPayLine, PatientAvatar, PayLines, payLinesBody, payLinesValid, PrintPreview, type PayLine } from './ui'

const TYPES: { key: DischargeType; tone: string; help: string }[] = [
  { key: 'Normal', tone: 'emerald', help: 'Routine discharge on medical advice.' },
  { key: 'DAMA', tone: 'amber', help: 'Discharged against medical advice — consent form and risk explanation required.' },
  { key: 'LAMA', tone: 'amber', help: 'Left against medical advice — document the counselling and the attendant’s signature.' },
  { key: 'Transfer', tone: 'sky', help: 'Referred / transferred to another hospital — attach the referral and transfer summary.' },
  { key: 'Absconded', tone: 'red', help: 'Patient left without informing — intimate security and, for MLC, the police.' },
  { key: 'Death', tone: 'slate', help: 'Death — the death summary and certificate (MCCD) are required; body handed over via mortuary.' },
]
const TONE: Record<string, string> = {
  emerald: 'bg-emerald-600 text-white ring-emerald-600', amber: 'bg-amber-500 text-white ring-amber-500', sky: 'bg-sky-600 text-white ring-sky-600',
  red: 'bg-red-600 text-white ring-red-600', slate: 'bg-slate-700 text-white ring-slate-700',
}
const TONE_IDLE: Record<string, string> = {
  emerald: 'text-emerald-800 ring-emerald-600/30 dark:text-emerald-300', amber: 'text-amber-800 ring-amber-600/30 dark:text-amber-300',
  sky: 'text-sky-800 ring-sky-600/30 dark:text-sky-300', red: 'text-red-700 ring-red-600/30 dark:text-red-300', slate: 'text-ink-2 ring-line-2',
}

interface Done { admission: { code: string; ended_at: string }; turnaround_request: { code: string } | null }

/** Three-step discharge: settle the bill → discharge details → release the bed. */
export function DischargeWizard({ admissionId, onClose, onBackToBill }: { admissionId: string; onClose: () => void; onBackToBill?: () => void }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const q = useQuery({ queryKey: K.discharge(admissionId), queryFn: () => api<DischargeData>(`/ipbilling/admissions/${admissionId}/discharge`) })
  const d = q.data
  const [lines, setLines] = useState<PayLine[]>([newPayLine()])
  const [remarks, setRemarks] = useState('')
  const [dtype, setDtype] = useState<DischargeType>('Normal')
  const [reason, setReason] = useState('')
  const [adjust, setAdjust] = useState(false)
  const [recovery, setRecovery] = useState<{ employee_id: string | null; amount: string }>({ employee_id: null, amount: '' })
  const [print, setPrint] = useState<{ format: PrintFormat; title: string } | null>(null)
  const [docs, setDocs] = useState(false)
  const [bell, setBell] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const amountRef = useRef<HTMLDivElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)
  const settleRef = useRef<HTMLDivElement>(null)
  const releaseRef = useRef<HTMLDivElement>(null)
  const due = Math.max(0, d?.position.balance ?? 0)
  const seeded = useRef(false)
  useEffect(() => {
    if (!d || seeded.current) return
    seeded.current = true
    setDtype(d.draft.discharge_type ?? 'Normal')
    setReason(d.draft.remarks ?? '')
  }, [d])
  useEffect(() => { setLines([newPayLine(due ? String(due) : '')]) }, [due])

  const refresh = () => { qc.invalidateQueries({ queryKey: K.all }) }
  const collect = useMutation({
    mutationFn: () => api<{ receipts: { code: string; amount: number }[] }>(`/ipbilling/admissions/${admissionId}/receipts`, {
      method: 'POST', body: { lines: payLinesBody(lines), remarks: remarks || undefined, purpose: 'settlement' },
    }),
    onSuccess: (r) => { toast.success(`Collected ${money(r.receipts.reduce((s, x) => s + x.amount, 0))} · ${r.receipts.map((x) => x.code).join(', ')}`); setRemarks(''); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const draft = useMutation({
    mutationFn: (body: { discharge_type: DischargeType; remarks?: string }) => api(`/ipbilling/admissions/${admissionId}/discharge-draft`, { method: 'PUT', body }),
  })
  const notify = useMutation({
    mutationFn: (step: 'settle' | 'details' | 'release') => api<{ roles: string[] }>(`/ipbilling/admissions/${admissionId}/notify`, { method: 'POST', body: { step } }),
    onSuccess: (r) => { toast.success(`Notified ${r.roles.join(', ')}`); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const initiate = useMutation({
    mutationFn: () => api(`/ipbilling/admissions/${admissionId}/initiate-discharge`, { method: 'POST', body: { discharge_type: dtype, remarks: reason || undefined } }),
    onSuccess: () => { toast.success('Discharge initiated — the ward checklist is open for sign-off'); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const recoveryAmt = Number(recovery.amount || 0)
  const confirm = useMutation({
    mutationFn: () => api<Done>(`/ipbilling/admissions/${admissionId}/discharge`, {
      method: 'POST', body: {
        discharge_type: dtype, remarks: reason || undefined,
        employee_recovery: adjust && recovery.employee_id && recoveryAmt > 0 ? { employee_id: recovery.employee_id, amount: recoveryAmt } : undefined,
      },
    }),
    onSuccess: (r) => { setDone(r); toast.success(`${r.admission.code} discharged — bed released`); refresh() },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray((e.details as { pending?: string[] })?.pending)) {
        toast.error(`Discharge blocked: ${((e.details as { pending: string[] }).pending).slice(0, 3).join('; ')}`)
      } else toast.error(errorMessage(e))
      refresh()
    },
  })

  const perms = d?.permissions
  const coverByRecovery = adjust && recovery.employee_id && recoveryAmt > 0 && recoveryAmt >= due - 0.009
  const blockedBalance = due > 0.009 && !coverByRecovery
  const clinical = d?.clinical_pending ?? []
  const notInitiated = d?.admission.status === 'Admitted'
  const canConfirm = !!perms?.discharge && !blockedBalance && !clinical.length && !notInitiated && !done

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!d) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (canConfirm && !confirm.isPending) confirm.mutate(); return }
      if (!e.altKey) return
      if (e.code === 'KeyC') { amountRef.current?.querySelector<HTMLInputElement>('input[type=number]')?.focus(); settleRef.current?.scrollIntoView({ behavior: 'smooth' }) }
      else if (e.code === 'KeyD') detailsRef.current?.scrollIntoView({ behavior: 'smooth' })
      else if (e.code === 'KeyB') (onBackToBill ?? (() => nav(`/ip/billing/${admissionId}`)))()
      else if (e.code === 'KeyS') openSummary()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !print && !docs) onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, print, docs])

  function openSummary() {
    const s = d?.readiness?.summary
    if (s?.id) window.open(`/print/discharge/summaries/${s.id}`, '_blank', 'noopener')
    else setPrint({ format: 'casesheet', title: `Case Sheet · ${d?.patient.name}` })
  }
  const back = onBackToBill ?? (() => { onClose(); nav(`/ip/billing/${admissionId}`) })

  const body = (() => {
    if (q.isLoading) return <Spinner label="Loading the discharge…" />
    if (q.error) return <ErrorBox error={q.error} />
    if (!d || !perms) return null
    const a = d.admission
    const p = d.position
    const pct = Math.min(100, Math.max(0, p.percent_paid))
    const tinfo = TYPES.find((t) => t.key === dtype)!
    const steps = [
      { n: 1, label: 'Settle the bill', sub: due > 0.009 ? `${money(due)} due` : 'Settled', done: due <= 0.009, ref: settleRef },
      { n: 2, label: 'Discharge details', sub: dtype, done: !!dtype, ref: detailsRef },
      { n: 3, label: 'Release the bed', sub: done ? 'Released' : `${(blockedBalance ? 1 : 0) + clinical.length + (notInitiated ? 1 : 0)} to go`, done: !!done, ref: releaseRef },
    ]
    const discharged = a.status === 'Discharged'
    return (
      <div className="space-y-4">
        {/* patient */}
        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-start gap-3">
            <PatientAvatar p={d.patient} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold text-ink">{d.patient.name}</span>
                <StatusBadge status={a.status} />
                {(d.patient.allergies ?? []).length ? <Badge tone="red">Allergies: {(d.patient.allergies ?? []).join(', ')}</Badge> : <Badge tone="amber">No allergy recorded</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <Badge tone="blue">IP {a.ip_no}</Badge><span>UHID <Copyable value={d.patient.uhid} /></span>{d.patient.phone && <span>{d.patient.phone}</span>}
                <Badge tone="violet">{d.sponsor.payer_type === 'Self' ? 'GENERAL' : d.sponsor.payer_type.toUpperCase()}</Badge>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="relative">
                <Button size="sm" onClick={() => setBell(!bell)} aria-expanded={bell}><Bell className="size-4" />Notifications{d.notifications.length ? ` (${d.notifications.length})` : ''}</Button>
                {bell && (
                  <div className="absolute right-0 z-30 mt-1 w-80 rounded-lg border border-line bg-surface p-2 text-xs shadow-xl">
                    {!d.notifications.length ? <p className="p-2 text-ink-3">No one has been notified yet.</p> : d.notifications.map((n, i) => (
                      <div key={i} className="border-b border-line px-1 py-1.5 last:border-0"><div className="text-ink">{n.message}</div><div className="text-ink-3">{dateTime(n.at)} · {n.by} → {n.roles.join(', ')}</div></div>
                    ))}
                  </div>
                )}
              </div>
              <Button size="sm" icon="Printer" onClick={() => setPrint({ format: d.invoices.length ? 'final' : 'summarised', title: `${d.invoices.length ? 'Final' : 'Summarised'} bill · ${d.patient.name}` })}>View bill</Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Tile icon="BedDouble" label="Ward / bed" value={[a.ward?.name, a.bed?.bed_no].filter(Boolean).join(' · ') || '—'} />
            <Tile icon="Stethoscope" label="Consultant" value={a.doctor ?? '—'} />
            <Tile icon="CalendarDays" label="Admitted" value={`${date(a.admitted_at)} · ${a.los_days} days`} />
            <Tile icon="CalendarCheck" label="Discharged" value={a.discharged_at ? dateTime(a.discharged_at) : done ? dateTime(done.admission.ended_at) : '—'} />
          </div>
        </div>

        {/* stepper */}
        <ol className="grid gap-2 sm:grid-cols-3" aria-label="Discharge steps">
          {steps.map((s, i) => (
            <li key={s.n}>
              <button type="button" onClick={() => s.ref.current?.scrollIntoView({ behavior: 'smooth' })}
                className={cn('flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left', i === 0 && !s.done ? 'border-brand-600/50 bg-brand-50/60 dark:bg-brand-500/10' : 'border-line bg-surface')}>
                <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold', s.done ? 'bg-emerald-600 text-white' : 'bg-surface-2 text-ink-2 ring-1 ring-line')}>
                  {s.done ? <Icon name="Check" className="size-4" /> : s.n}
                </span>
                <span><span className="block text-sm font-medium text-ink">{s.label}</span><span className="block text-xs text-ink-3">{s.sub}</span></span>
              </button>
            </li>
          ))}
        </ol>

        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Kpi icon="Receipt" label="Net bill" value={money(p.net)} hint={`gross ${money(p.gross)}`} />
          <Kpi icon="User" label="Patient payable" value={money(p.patient_payable)} hint={p.sponsor_payable ? `sponsor pays ${money(p.sponsor_payable)}` : "patient's share"} />
          <Kpi icon="Wallet" label="Paid so far" value={money(p.paid)} hint={`incl. ${money(p.advance)} advance`} />
          <Kpi icon="AlertTriangle" label={p.balance < -0.009 ? 'Refundable' : 'Balance due'} value={money(Math.abs(p.balance))} hint={due > 0.009 ? 'collect before discharge' : p.balance < -0.009 ? 'surplus advance' : 'nothing due'} alert={due > 0.009} />
        </div>
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Paid">
            <div className="h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-right text-xs text-ink-3">{Math.round(pct)}% paid</div>
        </div>

        {done && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
            <div className="flex items-center gap-2 font-semibold"><Icon name="CircleCheck" className="size-5" />{done.admission.code} discharged at {dateTime(done.admission.ended_at)}</div>
            <p className="mt-1">The bed is released for cleaning{done.turnaround_request ? ` (housekeeping ${done.turnaround_request.code})` : ''}. The bill is settled.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon="Ticket" onClick={() => setPrint({ format: 'checkout', title: `Check-out Slip · ${d.patient.name}` })}>Check-out slip</Button>
              <Button size="sm" icon="FileText" onClick={() => setPrint({ format: 'final', title: `Final bill · ${d.patient.name}` })}>Final bill</Button>
              <Button size="sm" icon="ClipboardList" onClick={() => setPrint({ format: 'casesheet', title: `Case Sheet · ${d.patient.name}` })}>Case sheet</Button>
              <Button size="sm" icon="Paperclip" onClick={() => setDocs(true)}>Documents</Button>
            </div>
          </div>
        )}

        {!discharged && !done && (
          <>
            {/* step 1 */}
            <div ref={settleRef} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
              <section className="rounded-xl border border-line bg-surface">
                <StepHead n={1} title="Settle the bill" right={<>
                  <Badge tone={due > 0.009 ? 'amber' : 'green'}>{due > 0.009 ? `${money(due)} due` : 'Settled'}</Badge>
                  {perms.notify && <Button size="xs" variant="ghost" onClick={() => notify.mutate('settle')} loading={notify.isPending && notify.variables === 'settle'}><Bell className="size-3.5" />Notify</Button>}
                </>} />
                <div className="space-y-3 p-4">
                  {due > 0.009 && perms.collect ? (
                    <div ref={amountRef} className="rounded-xl border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/5"
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && (e.target as HTMLElement).tagName === 'INPUT' && !payLinesValid(lines)) { e.preventDefault(); collect.mutate() } }}>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div><div className="text-sm font-semibold text-ink">Collect {money(due)} to settle</div><div className="text-xs text-ink-3">Split across modes with “Add mode” · <kbd className="rounded border border-line-2 px-1 text-[10px]">Enter</kbd> collects</div></div>
                        <div className="flex gap-1.5">
                          <Button size="xs" onClick={() => setLines([{ ...lines[0], amount: String(due) }])}>Full due</Button>
                          <Button size="xs" onClick={() => setLines([{ ...lines[0], amount: String(Math.round(due / 2 * 100) / 100) }])}>Half</Button>
                        </div>
                      </div>
                      <PayLines lines={lines} onChange={setLines} due={due} />
                      <FieldWrap label="Remarks" className="mt-2"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional — printed on the receipt" /></FieldWrap>
                      <div className="mt-3 flex justify-end">
                        <Button variant="warning" icon="Wallet" disabled={!!payLinesValid(lines)} loading={collect.isPending} onClick={() => collect.mutate()}>
                          Collect {money(lines.reduce((s, l) => s + Number(l.amount || 0), 0))}
                        </Button>
                      </div>
                    </div>
                  ) : due > 0.009 ? (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{money(due)} is outstanding. Collection is done at the billing desk.</p>
                  ) : (
                    <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
                      <Icon name="CircleCheck" className="size-4" />The patient's share is covered{p.balance < -0.009 ? ` — ${money(-p.balance)} advance is surplus and can be refunded from the bill` : ''}. The advance is adjusted against the final bill on confirmation.
                    </p>
                  )}
                  {perms.write && (
                    <div className="rounded-lg border border-line">
                      <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm" onClick={() => setAdjust(!adjust)} aria-expanded={adjust}>
                        <span className="flex items-center gap-2"><Icon name="SlidersHorizontal" className="size-4 text-ink-3" /><b className="font-medium">Adjust settlement</b><span className="text-xs text-ink-3">discount, employee recovery, sponsor split</span></span>
                        <ChevronDown className={cn('size-4 text-ink-3 transition-transform', adjust && 'rotate-180')} />
                      </button>
                      {adjust && <Adjustments d={d} recovery={recovery} setRecovery={setRecovery} />}
                    </div>
                  )}
                  <p className="text-xs text-ink-3">Charges and service discounts are edited on the <Link to={`/ip/billing/${admissionId}`} onClick={onClose} className="text-brand-700 underline dark:text-brand-300">IP Approximate Bill</Link> screen.</p>
                </div>
              </section>
              <Breakdown d={d} />
            </div>

            {/* step 2 */}
            <section ref={detailsRef} className="rounded-xl border border-line bg-surface">
              <StepHead n={2} title="Discharge details" right={perms.notify && <Button size="xs" variant="ghost" onClick={() => notify.mutate('details')} loading={notify.isPending && notify.variables === 'details'}><Bell className="size-3.5" />Notify</Button>} />
              <div className="space-y-3 p-4">
                <div>
                  <div className="mb-1.5 text-xs font-medium text-ink-2">Discharge type</div>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Discharge type">
                    {TYPES.map((t) => (
                      <button key={t.key} type="button" role="radio" aria-checked={dtype === t.key} disabled={!perms.discharge}
                        onClick={() => { setDtype(t.key); if (perms.discharge) draft.mutate({ discharge_type: t.key, remarks: reason || undefined }) }}
                        className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset disabled:opacity-60', dtype === t.key ? TONE[t.tone] : TONE_IDLE[t.tone])}>
                        {dtype === t.key && <Icon name="Check" className="size-3.5" />}{t.key}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-ink-3">{tinfo.help}</p>
                </div>
                <FieldWrap label="Reason / remarks (optional)">
                  <Textarea rows={2} value={reason} disabled={!perms.discharge} onChange={(e) => setReason(e.target.value)}
                    onBlur={() => { if (perms.discharge && reason !== (d.draft.remarks ?? '')) draft.mutate({ discharge_type: dtype, remarks: reason || undefined }) }}
                    placeholder="e.g. Recovered, advised review after 7 days" />
                </FieldWrap>
              </div>
            </section>

            {/* step 3 */}
            <section ref={releaseRef} className="rounded-xl border border-line bg-surface">
              <StepHead n={3} title="Release the bed" right={perms.notify && <Button size="xs" variant="ghost" onClick={() => notify.mutate('release')} loading={notify.isPending && notify.variables === 'release'}><Bell className="size-3.5" />Notify</Button>} />
              <div className="space-y-2 p-4 text-sm">
                {notInitiated ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
                    <span>Discharge has not been initiated yet — initiating opens the ward checklist (summary, medication reconciliation, nursing clearance…).</span>
                    {perms.initiate && <Button size="sm" variant="primary" loading={initiate.isPending} onClick={() => initiate.mutate()}>Initiate discharge</Button>}
                  </div>
                ) : (
                  <>
                    <p className="text-ink-2">Confirming discharges the patient and sends bed <b>{a.bed?.bed_no ?? '—'}</b> to housekeeping for turnaround.</p>
                    {d.readiness && (
                      <ul className="grid gap-1 sm:grid-cols-2">
                        {d.readiness.items.filter((i) => i.applicable).map((i) => {
                          const billing = i.key === 'billing_cleared'
                          const ok = i.done || (billing && due <= 0.009)
                          return (
                            <li key={i.key} className="flex items-start gap-2 text-xs">
                              <Icon name={ok ? 'CircleCheck' : 'Circle'} className={cn('mt-0.5 size-3.5 shrink-0', ok ? 'text-emerald-600' : 'text-ink-3')} />
                              <span className={ok ? 'text-ink-2' : 'text-ink'}>{i.label}{billing && !i.done ? (due <= 0.009 ? ' — signed on confirmation' : '') : !i.done ? <span className="text-ink-3"> · {i.roles.join(' / ')}</span> : null}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </section>
          </>
        )}
        {discharged && !done && (
          <div className="rounded-xl border border-line bg-surface-2 p-4 text-sm text-ink-2">This patient was discharged on {dateTime(a.discharged_at)}.
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" icon="Ticket" onClick={() => setPrint({ format: 'checkout', title: `Check-out Slip · ${d.patient.name}` })}>Check-out slip</Button>
              <Button size="sm" icon="FileText" onClick={() => setPrint({ format: 'final', title: `Final bill · ${d.patient.name}` })}>Final bill</Button>
            </div>
          </div>
        )}
      </div>
    )
  })()

  const footer = d && !done && d.admission.status !== 'Discharged' && (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3">
      <span className="text-xs text-ink-2">Before discharge:</span>
      {blockedBalance && <Badge tone="amber"><Lock className="size-3" />Outstanding balance {money(due)}</Badge>}
      {notInitiated && <Badge tone="blue">Discharge not initiated</Badge>}
      {clinical.length > 0 && <span title={clinical.join('\n')}><Badge tone="amber"><Lock className="size-3" />{clinical.length} clearance(s) pending</Badge></span>}
      {!blockedBalance && !clinical.length && !notInitiated && <Badge tone="green">Ready</Badge>}
      <span className="ml-auto flex flex-wrap gap-2">
        <Button icon="FileText" onClick={openSummary}>Discharge summary</Button>
        {perms?.discharge && (
          <Button variant="primary" icon="CircleCheck" disabled={!canConfirm} loading={confirm.isPending} onClick={() => confirm.mutate()}
            title={!canConfirm ? [blockedBalance && 'Settle the balance', notInitiated && 'Initiate discharge', clinical.length && 'Clearances pending'].filter(Boolean).join(' · ') : undefined}>
            Confirm discharge &amp; release bed <kbd className="ml-1 rounded bg-white/20 px-1 text-[10px]">Ctrl+↵</kbd>
          </Button>
        )}
      </span>
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-2 backdrop-blur-[1px] sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label="Discharge" className="flex max-h-[calc(100vh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-plane shadow-2xl sm:max-h-[calc(100vh-2rem)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
          <Button size="sm" icon="ArrowLeft" onClick={back}>Back to bill</Button>
          <span className="grid size-9 place-items-center rounded-lg bg-brand-700 text-white"><Icon name="BedDouble" className="size-5" /></span>
          <div className="min-w-0"><h2 className="text-base font-semibold text-ink">Discharge</h2><p className="text-xs text-ink-2">Settle the bill → discharge details → release the bed.</p></div>
          <div className="ml-auto hidden lg:block"><KeyHints items={[['Alt+C', 'collect'], ['Alt+D', 'details'], ['Alt+B', 'bill'], ['Alt+S', 'summary'], ['Ctrl+↵', 'discharge']]} /></div>
          <button type="button" className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={onClose} aria-label="Close"><Icon name="X" className="size-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 scroll-thin sm:p-5">{body}</div>
        {footer}
      </div>
      {print && <PrintPreview open onClose={() => setPrint(null)} admissionId={admissionId} format={print.format} title={print.title} />}
      {docs && d && <DocumentsModal admissionId={admissionId} patientName={d.patient.name} onClose={() => setDocs(false)} />}
    </div>,
    document.body,
  )
}

function StepHead({ n, title, right }: { n: number; title: string; right?: ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><span className="grid size-6 place-items-center rounded-full bg-brand-50 text-xs text-brand-800 dark:bg-brand-500/15 dark:text-brand-200">{n}</span>{title}</h3>
      <div className="flex items-center gap-2">{right}</div>
    </header>
  )
}

function Tile({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
      <Icon name={icon} className="size-4 shrink-0 text-ink-3" />
      <div className="min-w-0"><div className="text-[11px] text-ink-3">{label}</div><div className="truncate text-sm font-medium text-ink">{value}</div></div>
    </div>
  )
}

function Kpi({ icon, label, value, hint, alert }: { icon: string; label: string; value: string; hint: string; alert?: boolean }) {
  return (
    <div className={cn('rounded-xl border bg-surface px-3 py-2.5', alert ? 'border-amber-400 ring-2 ring-amber-400/30' : 'border-line')}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-2"><Icon name={icon} className="size-3.5" />{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-[11px] text-ink-3">{hint}</div>
    </div>
  )
}

function Breakdown({ d }: { d: DischargeData }) {
  const qc = useQueryClient()
  const p = d.position
  const [edit, setEdit] = useState(false)
  const [approved, setApproved] = useState(String(d.sponsor.approved_amount ?? ''))
  useEffect(() => setApproved(String(d.sponsor.approved_amount ?? '')), [d.sponsor.approved_amount])
  const save = useMutation({
    mutationFn: () => api(`/ipbilling/admissions/${d.admission.id}/sponsor-terms`, { method: 'PUT', body: { approved_amount: approved === '' ? null : Number(approved), reason: 'Approved amount updated at the discharge desk' } }),
    onSuccess: () => { toast.success('Approved amount saved'); setEdit(false); qc.invalidateQueries({ queryKey: K.all }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const sponsored = d.sponsor.payer_type !== 'Self'
  const rows: [string, number, string?][] = [
    ['Charges (gross)', p.gross], ['Discounts', -p.discount], ['Net bill', p.net],
    ...(p.sponsor_payable ? [['Sponsor share', -p.sponsor_payable] as [string, number]] : []),
    ['Patient payable', p.patient_payable], ['Paid (incl. advance)', p.paid, 'text-emerald-700 dark:text-emerald-400'],
    [p.balance < -0.009 ? 'Refundable' : 'Balance due', Math.abs(p.balance), p.balance > 0.009 ? 'text-amber-700 dark:text-amber-300' : undefined],
  ]
  return (
    <aside className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 bg-brand-800 px-4 py-2.5 text-sm font-semibold text-white"><Icon name="Receipt" className="size-4" />Bill breakdown</div>
      <dl className="space-y-1.5 p-4 text-sm">
        {rows.map(([k, v, cls]) => <div key={k} className="flex justify-between gap-2"><dt className="text-ink-2">{k}</dt><dd className={cn('font-medium tabular-nums', cls)}>{money(v)}</dd></div>)}
        {sponsored && (
          <div className="mt-2 border-t border-line pt-2">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-2">Approved amount<span className="block text-[11px] text-ink-3">{d.sponsor.sponsor_name ?? d.sponsor.payer_type}{d.sponsor.co_pay_percent ? ` · co-pay ${d.sponsor.co_pay_percent}%` : ''}</span></dt>
              {edit ? (
                <span className="flex gap-1"><Input type="number" min={0} value={approved} autoFocus onChange={(e) => setApproved(e.target.value)} className="h-8 w-28 text-right" aria-label="Approved amount" />
                  <Button size="xs" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></span>
              ) : (
                <span className="flex items-center gap-1 font-medium tabular-nums">{d.sponsor.approved_amount != null ? money(d.sponsor.approved_amount) : <span className="text-amber-600">Not recorded</span>}
                  {d.permissions.write && <button type="button" aria-label="Edit approved amount" className="text-ink-3 hover:text-ink" onClick={() => setEdit(true)}><Icon name="Pencil" className="size-3.5" /></button>}</span>
              )}
            </div>
            {d.sponsor.approved_source && <p className="mt-1 text-[11px] text-ink-3">From {d.sponsor.approved_source}</p>}
          </div>
        )}
      </dl>
    </aside>
  )
}

function Adjustments({ d, recovery, setRecovery }: {
  d: DischargeData; recovery: { employee_id: string | null; amount: string }; setRecovery: (r: { employee_id: string | null; amount: string }) => void
}) {
  const qc = useQueryClient()
  const bd = d.bill_discount
  const [mode, setMode] = useState<'%' | '₹'>(bd.mode)
  const [value, setValue] = useState(bd.value ? String(bd.value) : '')
  const [reason, setReason] = useState(bd.reason ?? '')
  const save = useMutation({
    mutationFn: () => api<{ bill_discount: { status: string } }>(`/ipbilling/admissions/${d.admission.id}/bill-discount`, { method: 'PUT', body: { mode, value: Number(value || 0), reason: reason || undefined } }),
    onSuccess: (r) => { toast.success(r.bill_discount.status === 'Pending' ? 'Settlement discount sent for approval' : 'Settlement discount applied'); qc.invalidateQueries({ queryKey: K.all }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const due = Math.max(0, d.position.balance)
  return (
    <div className="grid gap-4 border-t border-line p-3 md:grid-cols-2">
      <div className="space-y-2">
        <div className="text-xs font-semibold text-ink">Settlement discount {bd.status !== 'None' && <StatusBadge status={bd.status} />}</div>
        <div className="flex gap-2">
          <Select value={mode} onChange={(e) => setMode(e.target.value as '%' | '₹')} className="w-20 shrink-0" aria-label="Discount unit"><option value="%">%</option><option value="₹">₹</option></Select>
          <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" aria-label="Discount value" />
        </div>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason — printed on the bill" aria-label="Discount reason" />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-3">Above {d.policy.discount_approval_percent}% goes to management for approval.</span>
          <Button size="xs" loading={save.isPending} disabled={Number(value || 0) > 0 && !reason.trim()} onClick={() => save.mutate()}>Apply</Button>
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-semibold text-ink">Employee recovery <span className="font-normal text-ink-3">(staff / dependant — salary deduction)</span></div>
        <RefPicker refName="employees.employees" value={recovery.employee_id} onChange={(id) => setRecovery({ ...recovery, employee_id: id })} placeholder="Employee to recover from" />
        <div className="flex gap-2">
          <Input type="number" min={0} max={due} value={recovery.amount} onChange={(e) => setRecovery({ ...recovery, amount: e.target.value })} placeholder="Amount (₹)" aria-label="Recovery amount" />
          <Button size="sm" onClick={() => setRecovery({ ...recovery, amount: String(due) })} disabled={!due}>Full due</Button>
        </div>
        <p className="text-[11px] text-ink-3">Posted on confirmation; HR receives a recovery request for the monthly deduction.</p>
      </div>
      <div className="md:col-span-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
        <b className="text-ink">Auto split:</b> the sponsor pays {d.sponsor.payer_type === 'Self' ? 'nothing (self-pay)' : `up to the approved amount after ${d.sponsor.co_pay_percent}% co-pay`}; the patient pays the rest. The sponsor's share is moved to an insurance / corporate claim on confirmation.
      </div>
    </div>
  )
}
