import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, Spinner } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { dateTime, time } from '@/lib/format'
import { DK, MACHINE_TONE, SESSION_TONE, type Machine, type Session, type TodayBoard } from './api'

/** Today's sessions strip, the machine board and the patient's session history. */

export function TodayStrip({ data, loading, error, activePid, onOpen }: {
  data?: TodayBoard; loading: boolean; error: unknown; activePid: string | null; onOpen: (pid: string) => void
}) {
  const order = ['In Progress', 'Checked In', 'Scheduled', 'Completed', 'Missed', 'Cancelled']
  const counts = Object.entries(data?.by_status ?? {}).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  return (
    <Card pad={false} title="Today's sessions" icon="CalendarClock" actions={
      <div className="flex flex-wrap items-center gap-1">
        {counts.map(([st, n]) => <Badge key={st} tone={SESSION_TONE[st] ?? 'gray'} dot>{st} {n}</Badge>)}
      </div>
    }>
      {loading ? <Spinner className="py-4" /> : error ? <div className="p-3"><ErrorBox error={error} /></div> : !data?.sessions.length ? (
        <p className="px-4 py-3 text-sm text-ink-3">No dialysis session today yet.</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto px-3 py-3 scroll-thin">
          {[...data.sessions].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map((s) => (
            <button key={s.id} type="button" disabled={!s.patient} onClick={() => s.patient && onOpen(s.patient.id)}
              title={`${s.code} · ${s.billing_ref ?? ''}`}
              className={cn('w-60 shrink-0 rounded-lg border px-2.5 py-2 text-left hover:bg-surface-2',
                s.patient?.id === activePid ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600/30 dark:bg-brand-500/10' : 'border-line')}>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink">{s.patient?.name ?? 'Patient'}</span>
                <Badge tone={SESSION_TONE[s.status] ?? 'gray'} dot>{s.status}</Badge>
              </span>
              <span className="mt-0.5 block truncate text-xs text-ink-3 tabular">
                {[s.code, s.modality, s.machine, s.started_at ? `start ${time(s.started_at)}` : s.checked_in_at ? `in ${time(s.checked_in_at)}` : null,
                  s.ended_at && s.status === 'Completed' ? `out ${time(s.ended_at)}` : null].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

export function MachineBoard({ machines, canOperate, loading }: { machines?: Machine[]; canOperate: boolean; loading?: boolean }) {
  const qc = useQueryClient()
  const ready = useMutation({
    mutationFn: (m: Machine) => post<Machine>(`/dialysis/desk/machines/${m.id}/ready`),
    onSuccess: (_, m) => { toast.success(`${m.name} is ready`); qc.invalidateQueries({ queryKey: DK.all }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const list = machines ?? []
  const counts = list.reduce<Record<string, number>>((a, m) => ({ ...a, [m.status]: (a[m.status] ?? 0) + 1 }), {})
  return (
    <Card pad={false} title="Machines" icon="MonitorCog" actions={<span className="text-xs text-ink-3 tabular">{counts.Available ?? 0} of {list.length} available</span>}>
      {loading ? <Spinner className="py-4" /> : !list.length ? <Empty icon="MonitorX" title="No dialysis machines configured" /> : (
        <ul className="divide-y divide-line">
          {list.map((m) => (
            <li key={m.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">{m.name}{m.station && <span className="text-xs font-normal text-ink-3">{m.station}</span>}</span>
                <span className="block truncate text-xs text-ink-2">{m.segregation ?? 'General (non-reactive)'}</span>
              </span>
              <Badge tone={MACHINE_TONE[m.status] ?? 'gray'} dot>{m.status}</Badge>
              {canOperate && m.status === 'Disinfection' && (
                <Button size="xs" variant="secondary" loading={ready.isPending && ready.variables?.id === m.id} onClick={() => ready.mutate(m)}
                  title="Disinfection finished — make the machine available">Mark ready</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function SessionHistory({ sessions }: { sessions: Session[] }) {
  if (!sessions.length) return <Empty icon="History" title="No dialysis sessions recorded yet" />
  const head = ['Date', 'Session', 'Modality', 'Machine', 'Weight pre → post', 'UF achieved / goal', 'Kt/V', 'Events', 'Billed on', 'Status']
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
          <tr>{head.map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const events = (s.intradialytic_events ?? []).filter((e) => e !== 'None')
            return (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="whitespace-nowrap px-3 py-2 text-ink-2 tabular">{dateTime(s.started_at ?? s.scheduled_at)}</td>
                <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">{s.code}</td>
                <td className="px-3 py-2 text-ink-2">{s.modality ?? '—'}</td>
                <td className="px-3 py-2 text-ink-2">{s.machine_name ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-ink-2 tabular">{s.pre_weight ?? '—'} → {s.post_weight ?? '—'} kg</td>
                <td className="whitespace-nowrap px-3 py-2 text-ink-2 tabular">{s.uf_achieved_ml ?? '—'} / {s.uf_goal_ml ?? '—'} ml</td>
                <td className="px-3 py-2 text-ink-2 tabular">{s.ktv ?? '—'}</td>
                <td className="max-w-48 px-3 py-2">
                  {events.length ? <span className="text-xs text-amber-700 dark:text-amber-300" title={s.complications ?? undefined}>{events.join(', ')}</span>
                    : s.status === 'Completed' ? <span className="text-xs text-ink-3">None</span> : <span className="text-xs text-ink-3">—</span>}
                </td>
                <td className="max-w-48 truncate px-3 py-2 text-xs text-ink-3" title={s.billing_ref ?? undefined}>{s.billing_ref ?? '—'}</td>
                <td className="px-3 py-2"><Badge tone={SESSION_TONE[s.status] ?? 'gray'} dot>{s.status}</Badge></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
