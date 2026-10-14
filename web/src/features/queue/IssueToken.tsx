import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Ban, Check, LogOut, Printer, Search, Ticket } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RefPicker, useDebounced } from '@/components/fields'
import { Badge, Button, cn, Empty, ErrorBox, Input, Spinner, Switch } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { minutes } from '@/lib/format'
import { useQueueAccess } from './access'
import { useClock } from './tv'
import { PRIORITIES, type IssueResult, type Kiosk, type KioskLine, type Priority } from './types'
import { groupLines, isDoctorQueue, printSlip } from './ui'

const RESET_S = 10
const AUTOPRINT_KEY = 'vlack.queue.kiosk.autoprint'
const readAutoPrint = () => { try { return localStorage.getItem(AUTOPRINT_KEY) === '1' } catch { return false } }
const PRIORITY_HINT: Record<Priority, string> = {
  Normal: 'General queue', 'Senior Citizen': 'Age 60 and above', 'Differently Abled': 'Persons with disability', Emergency: 'Urgent — served first',
}

type Step = { kind: 'pick' } | { kind: 'details'; line: KioskLine } | { kind: 'done'; line: KioskLine; result: IssueResult } | { kind: 'full'; line: KioskLine; message: string }

/**
 * Issue Token — a touch-first, full-screen kiosk (/queue/issue): pick a line (counters & services,
 * or a doctor cabin by department), optionally link the patient or a mobile number for the SMS call
 * alert, choose the priority and get a token with "N ahead". The screen resets itself after 10 s.
 */
export default function IssueToken() {
  const access = useQueueAccess()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [autoPrint, setAutoPrint] = useState(readAutoPrint)
  const kiosk = useQuery({
    queryKey: ['x', 'queue', 'kiosk'],
    queryFn: () => api<Kiosk>('/queue/kiosk'),
    enabled: access.issue,
    refetchInterval: 15_000,
  })
  const hospital = kiosk.data?.hospital ?? access.hospital

  useEffect(() => {
    const prev = document.title
    document.title = 'Issue token · Vlack HRMS'
    return () => { document.title = prev }
  }, [])
  useEffect(() => {
    if (step.kind === 'pick') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setStep({ kind: 'pick' }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step.kind])

  const toggleAutoPrint = (v: boolean) => {
    setAutoPrint(v)
    try { localStorage.setItem(AUTOPRINT_KEY, v ? '1' : '0') } catch { /* storage unavailable */ }
  }
  const slip = (line: KioskLine, r: IssueResult) => printSlip({
    label: r.token.label, queueName: r.queue_name, hospital: r.hospital || hospital, ahead: r.ahead, priority: r.token.priority,
    room: line.room, estWaitMin: line.est_wait_min,
  })
  const onIssued = (line: KioskLine, result: IssueResult) => {
    qc.invalidateQueries({ queryKey: ['x', 'queue'] })
    setStep({ kind: 'done', line, result })
    if (autoPrint) slip(line, result)
  }

  if (!access.ready) return <div className="grid min-h-dvh place-items-center bg-plane"><Spinner /></div>
  if (!access.issue) {
    return (
      <div className="grid min-h-dvh place-items-center bg-plane p-6">
        <Empty icon="Lock" title="Your role cannot issue tokens" action={<Link to="/" className="text-sm text-brand-700 hover:underline dark:text-brand-300">Back to the dashboard</Link>}>
          Token issue is available to the front office. Ask an administrator if you need it.
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col bg-plane text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-700 text-white"><Ticket className="size-7" /></div>
          <div className="min-w-0">
            <div className="truncate text-2xl font-bold tracking-tight">{hospital || 'Token kiosk'}</div>
            <div className="text-sm text-ink-2">Get your token · टोकन लें · టోకెన్ పొందండి</div>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Switch checked={autoPrint} onChange={toggleAutoPrint} label="Print the slip automatically" /> Auto-print slip
          </label>
          <KioskClock />
          <Link to={access.console ? '/m/queue/queue-console' : '/'} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
            title="Leave the kiosk screen"><LogOut className="size-4" /> Exit</Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {step.kind === 'pick' && (
          <PickLine kiosk={kiosk.data} loading={kiosk.isLoading} error={kiosk.error} onPick={(line) => setStep({ kind: 'details', line })} />
        )}
        {step.kind === 'details' && (
          <Details line={step.line} onBack={() => setStep({ kind: 'pick' })} onIssued={(r) => onIssued(step.line, r)}
            onFull={(message) => { qc.invalidateQueries({ queryKey: ['x', 'queue', 'kiosk'] }); setStep({ kind: 'full', line: step.line, message }) }} />
        )}
        {step.kind === 'done' && (
          <Done line={step.line} result={step.result} onPrint={() => slip(step.line, step.result)} onReset={() => setStep({ kind: 'pick' })} />
        )}
        {step.kind === 'full' && (
          <div className="mx-auto max-w-2xl rounded-3xl border border-line bg-surface p-10 text-center shadow-sm" role="alert">
            <div className="mx-auto grid size-16 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300"><Ban className="size-8" /></div>
            <h2 className="mt-4 text-3xl font-bold">{step.line.name} is full for today</h2>
            <p className="mt-2 text-lg text-ink-2">{step.message}</p>
            <p className="mt-1 text-lg text-ink-2">Please ask at the help desk — emergencies are always seen.</p>
            <Button variant="primary" className="mt-8 h-14 px-8 text-lg" onClick={() => setStep({ kind: 'pick' })}><ArrowLeft className="size-5" /> Choose another</Button>
          </div>
        )}
      </main>
    </div>
  )
}

function KioskClock() {
  const now = useClock()
  return (
    <div className="text-right">
      <div className="tabular text-2xl font-semibold leading-none">{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</div>
      <div className="text-xs text-ink-3">{now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
    </div>
  )
}

// ------------------------------------------------------------------ step 1: pick a line

function PickLine({ kiosk, loading, error, onPick }: { kiosk?: Kiosk; loading: boolean; error: unknown; onPick: (l: KioskLine) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 150).trim().toLowerCase()
  const groups = useMemo(() => {
    const lines = (kiosk?.lines ?? []).filter((l) => !dq || [l.name, l.owner, l.department, l.kind, l.room, l.queue].some((v) => v?.toLowerCase().includes(dq)))
    return groupLines(lines)
  }, [kiosk, dq])
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Where do you need to go?</h1>
          <p className="mt-1 text-lg text-ink-2">Tap a counter or a doctor to get your token.</p>
        </div>
        <div className="relative w-full sm:w-96">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search doctor, department or service" aria-label="Search lines"
            className="h-14 rounded-2xl pl-12 text-lg" />
        </div>
      </div>
      {groups.length > 2 && (
        <nav className="flex flex-wrap gap-2" aria-label="Jump to a department">
          {groups.map((g) => (
            <button key={g.key} type="button" onClick={() => document.getElementById(`kiosk-${g.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="h-11 rounded-full border border-line-2 bg-surface px-4 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
              {g.label}
            </button>
          ))}
        </nav>
      )}
      {error ? <ErrorBox error={error} /> : null}
      {loading && <Spinner />}
      {kiosk && groups.length === 0 && <Empty icon="SearchX" title={dq ? 'Nothing matches your search' : 'No lines are open for tokens'} />}
      {groups.map((g) => (
        <section key={g.key} id={`kiosk-${g.key}`} className="scroll-mt-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-3">{g.label}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((l) => (
              <button key={l.queue} type="button" onClick={() => onPick(l)}
                className={cn('flex min-h-32 flex-col justify-between rounded-2xl border-2 bg-surface p-5 text-left shadow-sm transition-colors active:scale-[0.99]',
                  'hover:border-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
                  l.at_capacity ? 'border-red-200 dark:border-red-500/30' : 'border-line')}>
                <span className="min-w-0">
                  <span className="block truncate text-xl font-semibold text-ink">{l.name}</span>
                  <span className="block truncate text-sm text-ink-2">
                    {[isDoctorQueue(l.queue) ? l.department : l.kind !== l.name ? l.kind : null, l.room && `Room ${l.room}`].filter(Boolean).join(' · ') || ' '}
                  </span>
                </span>
                <span className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="tabular text-ink-2"><b className="text-lg text-ink">{l.waiting}</b> waiting{l.waiting ? ` · ~${minutes(l.est_wait_min)}` : ''}</span>
                  {l.at_capacity ? <Badge tone="red" dot>Full today</Badge> : l.waiting === 0 ? <Badge tone="green" dot>No wait</Badge> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ step 2: patient + priority

function Details({ line, onBack, onIssued, onFull }: {
  line: KioskLine; onBack: () => void; onIssued: (r: IssueResult) => void; onFull: (message: string) => void
}) {
  const [patientId, setPatientId] = useState<string | null>(null)
  const [mobile, setMobile] = useState('')
  const [priority, setPriority] = useState<Priority>('Normal')
  const digits = mobile.replace(/\D/g, '')
  const mobileError = digits && !/^[6-9]\d{9}$/.test(digits) ? 'Enter a 10-digit mobile number' : undefined
  const blocked = line.at_capacity && priority !== 'Emergency'
  const issue = useMutation({
    mutationFn: () => api<IssueResult>('/queue/tokens', {
      method: 'POST',
      body: { queue: line.queue, patient_id: patientId ?? undefined, mobile: !patientId && digits ? digits : undefined, priority, source: 'Kiosk' },
    }),
    onSuccess: onIssued,
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'AT_CAPACITY' || e.status === 409)) onFull(e.message)
      else toast.error(errorMessage(e))
    },
  })
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <div className="min-w-0">
          <div className="text-sm text-ink-3">Token for</div>
          <div className="truncate text-2xl font-bold">{line.name}</div>
          <div className="text-sm text-ink-2">
            {[line.department, line.room && `Room ${line.room}`, `${line.waiting} waiting`, line.waiting ? `about ${minutes(line.est_wait_min)}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <Button className="h-12 px-5 text-base" onClick={onBack}><ArrowLeft className="size-5" /> Change</Button>
      </div>

      <section className="space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Patient <span className="text-sm font-normal text-ink-3">(optional — for the SMS when you are called)</span></h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-sm font-medium text-ink-2">Registered patient (UHID / name)</div>
            <div className="[&_button]:h-12 [&_button]:text-base [&_input]:h-12 [&_input]:text-base">
              <RefPicker refName="registration.patients" kind="patient" value={patientId} onChange={(id) => setPatientId(id)} placeholder="Search UHID / name / mobile" />
            </div>
          </div>
          <div>
            <label htmlFor="kiosk-mobile" className="mb-1 block text-sm font-medium text-ink-2">or mobile number</label>
            <Input id="kiosk-mobile" type="tel" inputMode="numeric" autoComplete="off" maxLength={14} disabled={!!patientId}
              value={patientId ? '' : mobile} onChange={(e) => setMobile(e.target.value)} placeholder={patientId ? 'Using the patient’s mobile' : '10-digit mobile'}
              invalid={!!mobileError} className="h-12 text-lg tracking-wider" />
            {mobileError && <p className="mt-1 text-sm text-red-600">{mobileError}</p>}
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Priority</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={priority === p} onClick={() => setPriority(p)}
              className={cn('flex min-h-20 flex-col items-start justify-center rounded-xl border-2 px-4 py-3 text-left transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
                priority === p
                  ? p === 'Emergency' ? 'border-red-600 bg-red-50 dark:bg-red-500/10' : 'border-brand-700 bg-brand-50 dark:bg-brand-500/10'
                  : 'border-line bg-surface hover:bg-surface-2')}>
              <span className="flex items-center gap-1.5 text-base font-semibold text-ink">{priority === p && <Check className="size-4" />}{p}</span>
              <span className="text-xs text-ink-3">{PRIORITY_HINT[p]}</span>
            </button>
          ))}
        </div>
        {line.at_capacity && (
          <p className={cn('rounded-lg px-3 py-2 text-sm', blocked ? 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200')}>
            {line.name} has reached today's capacity{line.capacity ? ` of ${line.capacity} tokens` : ''}. Only emergency tokens can be issued — please see the help desk.
          </p>
        )}
      </section>

      <Button variant="primary" className="h-16 w-full rounded-2xl text-xl" disabled={blocked || !!mobileError} loading={issue.isPending} onClick={() => issue.mutate()}>
        <Ticket className="size-6" /> Get token
      </Button>
    </div>
  )
}

// ------------------------------------------------------------------ step 3: the token

function Done({ line, result, onPrint, onReset }: { line: KioskLine; result: IssueResult; onPrint: () => void; onReset: () => void }) {
  const [left, setLeft] = useState(RESET_S)
  useEffect(() => {
    const t = window.setInterval(() => setLeft((s) => s - 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => { if (left <= 0) onReset() }, [left, onReset])
  const t = result.token
  return (
    <div className="mx-auto max-w-3xl rounded-3xl border border-line bg-surface p-6 text-center shadow-sm sm:p-10" role="status" aria-live="polite">
      <div className="text-lg text-ink-2">{result.queue_name}{line.room ? ` · Room ${line.room}` : ''}</div>
      <div className="text-sm uppercase tracking-[0.3em] text-ink-3">Your token</div>
      <div className="tabular my-4 whitespace-nowrap text-[clamp(44px,7.5vw,104px)] font-black leading-none tracking-wide text-brand-800 dark:text-brand-200">{t.label}</div>
      <div className="text-2xl font-semibold">{result.ahead === 0 ? 'You are next' : `${result.ahead} ahead of you`}</div>
      {result.ahead > 0 && line.est_wait_min > 0 && <div className="mt-1 text-lg text-ink-2">about {minutes(line.est_wait_min)}</div>}
      {t.priority && t.priority !== 'Normal' && <div className="mt-3"><Badge tone={t.priority === 'Emergency' ? 'red' : 'violet'}>{t.priority}</Badge></div>}
      <p className="mt-4 text-ink-2">Please watch the display screen for your number.</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <Button className="h-14 text-lg" onClick={onPrint}><Printer className="size-5" /> Print slip</Button>
        <Button variant="primary" className="h-14 text-lg" onClick={onReset}><Check className="size-5" /> Done</Button>
      </div>
      <div className="mt-6 text-sm text-ink-3">This screen resets in {Math.max(0, left)} s</div>
      <div className="mx-auto mt-2 h-1.5 max-w-xs overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-brand-600 transition-[width] duration-1000 ease-linear" style={{ width: `${(Math.max(0, left) / RESET_S) * 100}%` }} />
      </div>
    </div>
  )
}
