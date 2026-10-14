import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format, parseISO } from 'date-fns'
import { ChevronLeft, ChevronRight, Fingerprint, LockKeyhole, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Select, Spinner, StatTile, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { minutes, nowLocal, time, todayISO } from '@/lib/format'
import type { BespokeProps } from './index'

type State = 'Present' | 'Half Day' | 'Absent' | 'On Leave' | 'Expected' | 'Holiday' | 'Weekly Off'
interface BoardRow {
  employee_id: string; code: string; name: string; category?: string; designation?: string; department_id?: string; department: string
  ward_code?: string | null; shift?: string | null; shift_name?: string | null; shift_start?: string | null; shift_end?: string | null
  rostered: boolean; attendance_id?: string | null; check_in?: string | null; check_out?: string | null; hours_worked?: number | null
  late_minutes: number; overtime_hours: number; source?: string | null; state: State; leave_type?: string | null; remarks?: string | null
}
interface Tally { present: number; late: number; absent: number; on_leave: number; expected: number; rostered: number }
interface Board {
  date: string; as_of: string
  kpis: Tally & { staff: number; not_recorded: number; overtime_hours: number }
  by_department: (Tally & { department: string; department_id?: string })[]
  rows: BoardRow[]
}
interface Options { departments: { id: string; name: string }[] }
type Filter = 'all' | 'present' | 'late' | 'absent' | 'on_leave' | 'expected'

const SOURCES = ['Manual', 'Biometric', 'Face Recognition', 'Mobile Geo-fence'] as const
const matches = (r: BoardRow, f: Filter) => {
  switch (f) {
    case 'present': return r.state === 'Present' || r.state === 'Half Day'
    case 'late': return (r.state === 'Present' || r.state === 'Half Day') && r.late_minutes > 0
    case 'absent': return r.state === 'Absent'
    case 'on_leave': return r.state === 'On Leave'
    case 'expected': return r.state === 'Expected'
    default: return true
  }
}

export default function AttendanceBoard(_: BespokeProps) {
  const qc = useQueryClient()
  const meta = useMeta()
  const role = meta.data?.user.role
  const isHr = role === 'hr' || role === 'admin'
  const [day, setDay] = useState(todayISO)
  const [department, setDepartment] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [punchFor, setPunchFor] = useState<{ employee_id?: string; label?: string } | null>(null)
  const isToday = day === todayISO()

  const options = useQuery({ queryKey: ['x', 'roster', 'options'], queryFn: () => api<Options>('/hr/roster/options'), staleTime: 5 * 60_000 })
  const board = useQuery({
    queryKey: ['x', 'roster', 'attendance-board', day, department],
    queryFn: () => api<Board>('/hr/attendance/board', { query: { date: day, department } }),
    refetchInterval: isToday ? 30_000 : false,
    placeholderData: (prev) => prev,
  })
  const closeDay = useMutation({
    mutationFn: () => api<{ marked_absent: number }>('/hr/attendance/close-day', { method: 'POST', body: { att_date: day } }),
    onSuccess: (r) => { toast.success(`Day closed — ${r.marked_absent} rostered staff without a punch marked absent`); qc.invalidateQueries({ queryKey: ['x', 'roster'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const data = board.data
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (data?.rows ?? []).filter((r) => matches(r, filter) && (!term || `${r.name} ${r.code} ${r.designation ?? ''}`.toLowerCase().includes(term)))
  }, [data, filter, q])
  const k = data?.kpis

  const tile = (f: Filter, label: string, value: number | undefined, icon: string, hint?: string, alert?: boolean) => (
    <div className={cn('rounded-xl [&>button]:h-full [&>button]:w-full', filter === f && 'ring-2 ring-brand-600')}>
      <StatTile label={label} value={value ?? '—'} icon={icon} hint={hint} tone={alert ? 'alert' : 'default'} onClick={() => setFilter(filter === f ? 'all' : f)} />
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-line-2 bg-surface shadow-sm">
          <button className="rounded-l-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Previous day" onClick={() => setDay(format(addDays(parseISO(day), -1), 'yyyy-MM-dd'))}><ChevronLeft className="size-4" /></button>
          <input type="date" aria-label="Date" value={day} max={todayISO()} onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-8 border-x border-line-2 bg-surface px-2 text-sm text-ink tabular focus:outline-none" />
          <button className="rounded-r-lg p-2 text-ink-2 hover:bg-surface-2 disabled:opacity-40" aria-label="Next day" disabled={isToday}
            onClick={() => setDay(format(addDays(parseISO(day), 1), 'yyyy-MM-dd'))}><ChevronRight className="size-4" /></button>
        </div>
        {!isToday && <Button size="sm" variant="ghost" onClick={() => setDay(todayISO())}>Today</Button>}
        <div className="w-56">
          <Select aria-label="Department" className="h-8" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {options.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search staff…" className="h-8 pl-8" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
              {isToday && <span className="size-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />}
              {isToday ? 'Live' : 'As recorded'} · updated {time(data.as_of)}
            </span>
          )}
          <Button size="sm" variant="ghost" aria-label="Refresh" onClick={() => board.refetch()}><RefreshCw className={cn('size-4', board.isFetching && 'animate-spin')} /></Button>
          {isHr && !isToday && (
            <Button size="sm" loading={closeDay.isPending} onClick={() => {
              if (confirm(`Close ${format(parseISO(day), 'dd MMM yyyy')}? Rostered staff without a punch or approved leave will be marked absent (loss of pay).`)) closeDay.mutate()
            }}><LockKeyhole className="size-4" />Close day</Button>
          )}
          {isHr && <Button size="sm" variant="primary" onClick={() => setPunchFor({})}><Fingerprint className="size-4" />Manual punch</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tile('all', 'Rostered', k?.rostered, 'CalendarClock', k ? `${k.staff} active staff` : undefined)}
        {tile('present', 'Present', k?.present, 'UserCheck', k?.overtime_hours ? `${k.overtime_hours} h overtime` : undefined)}
        {tile('late', 'Late', k?.late, 'AlarmClock', 'beyond shift grace')}
        {tile('absent', 'Absent', k?.absent, 'UserX', 'rostered, no punch', !!k?.absent)}
        {tile('on_leave', 'On leave', k?.on_leave, 'Plane')}
        {tile('expected', isToday ? 'Yet to arrive' : 'Not closed', k?.expected, 'Hourglass', isToday ? 'shift not started' : undefined)}
      </div>

      {board.error && <ErrorBox error={board.error} />}
      {board.isLoading && <Spinner label="Loading attendance…" />}

      {data && (
        <>
          <Card title="By department" icon="Building2" pad={false}>
            {data.by_department.length === 0 ? <Empty icon="Building2" title="Nothing recorded yet" /> : (
              <ul className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {data.by_department.map((d) => {
                  const total = Math.max(1, d.present + d.absent + d.on_leave + d.expected)
                  return (
                    <li key={d.department} className="border-b border-line px-4 py-2.5 sm:border-r">
                      <div className="flex items-center justify-between text-sm">
                        <button className="truncate text-left font-medium text-ink hover:underline" onClick={() => d.department_id && setDepartment(d.department_id)}>{d.department}</button>
                        <span className="tabular text-xs text-ink-2">{d.present}/{d.present + d.absent + d.expected} in</span>
                      </div>
                      <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                        <span className="bg-emerald-500" style={{ width: `${((d.present - d.late) / total) * 100}%` }} />
                        <span className="bg-amber-400" style={{ width: `${(d.late / total) * 100}%` }} />
                        <span className="bg-red-500" style={{ width: `${(d.absent / total) * 100}%` }} />
                        <span className="bg-slate-400" style={{ width: `${(d.on_leave / total) * 100}%` }} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-3">
                        <span>{d.present} present</span>{d.late > 0 && <span>{d.late} late</span>}
                        {d.absent > 0 && <span className="text-red-700 dark:text-red-300">{d.absent} absent</span>}
                        {d.on_leave > 0 && <span>{d.on_leave} on leave</span>}{d.expected > 0 && <span>{d.expected} expected</span>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="flex flex-wrap gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-3">
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-500" />On time</span>
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-amber-400" />Late</span>
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-red-500" />Absent</span>
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-slate-400" />Leave</span>
            </div>
          </Card>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-ink-2">
              <span>{rows.length} of {data.rows.length} staff{filter !== 'all' && <button className="ml-2 text-brand-700 hover:underline dark:text-brand-300" onClick={() => setFilter('all')}>Show all</button>}</span>
              <span>{k?.not_recorded ?? 0} staff not rostered and without a punch are not listed</span>
            </div>
            <div className="max-h-[62vh] overflow-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-ink-2">
                  <tr>
                    {['Staff', 'Department', 'Shift', 'In', 'Out', 'Hours', 'Late', 'OT', 'Source', 'Status', ''].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-line px-3 py-2 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.employee_id} className="border-b border-line last:border-0 hover:bg-surface-2">
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <div className="font-medium text-ink">{r.name}</div>
                        <div className="text-xs text-ink-3">{r.code} · {r.designation}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-ink-2">{r.department}{r.ward_code ? <span className="text-ink-3"> · {r.ward_code}</span> : null}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {r.shift ? <span title={r.shift_name ?? undefined}><Badge tone="gray">{r.shift}</Badge> <span className="tabular text-xs text-ink-3">{r.shift_start}–{r.shift_end}</span></span> : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5">{r.check_in ? time(r.check_in) : '—'}</td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5">{r.check_out ? time(r.check_out) : r.check_in ? <span className="text-ink-3">on duty</span> : '—'}</td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5">{r.hours_worked ?? '—'}</td>
                      <td className={cn('tabular whitespace-nowrap px-3 py-1.5', r.late_minutes > 0 && 'font-medium text-amber-700 dark:text-amber-300')}>{r.late_minutes > 0 ? minutes(r.late_minutes) : '—'}</td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5">{r.overtime_hours ? `${r.overtime_hours} h` : '—'}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{r.source ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {r.state === 'Expected' ? <Badge tone="gray" dot>Yet to arrive</Badge> : <StatusBadge status={r.state} />}
                        {r.leave_type && <span className="ml-1 text-xs text-ink-3">{r.leave_type}</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        {isHr && (r.state !== 'On Leave') && !(r.check_in && r.check_out) && (
                          <Button size="xs" variant="ghost" onClick={() => setPunchFor({ employee_id: r.employee_id, label: `${r.name} · ${r.code}` })}>
                            {r.check_in ? 'Punch out' : 'Punch in'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && (
                <Empty icon="Fingerprint" title={data.rows.length ? 'Nobody matches this filter' : 'No attendance or roster for this day'}>
                  {data.rows.length ? undefined : 'Publish the duty roster and connect the biometric / face terminals, or record punches manually.'}
                </Empty>
              )}
            </div>
          </div>
        </>
      )}

      {punchFor && <PunchModal initial={punchFor} day={day} onClose={() => setPunchFor(null)} onDone={() => qc.invalidateQueries({ queryKey: ['x', 'roster'] })} />}
    </div>
  )
}

function PunchModal({ initial, day, onClose, onDone }: { initial: { employee_id?: string; label?: string }; day: string; onClose: () => void; onDone: () => void }) {
  const [employee, setEmployee] = useState<string | null>(initial.employee_id ?? null)
  const [label, setLabel] = useState<string | undefined>(initial.label)
  const [source, setSource] = useState<(typeof SOURCES)[number]>('Manual')
  const [at, setAt] = useState(() => (day === todayISO() ? nowLocal() : `${day}T09:00`))
  const [remarks, setRemarks] = useState('')
  const punch = useMutation({
    mutationFn: () => api<{ action: string; message: string }>('/hr/attendance/punch', {
      method: 'POST', body: { employee_id: employee, source, at, remarks: remarks || undefined },
    }),
    onSuccess: (r) => {
      if (r.action === 'duplicate') toast.info(`${r.message} — ignored as a duplicate`)
      else toast.success(`${label ?? 'Punch'}: ${r.message}`)
      onDone()
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const needsReason = source === 'Manual' && remarks.trim().length < 3
  return (
    <Modal open onClose={onClose} title="Record a punch" size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={punch.isPending} disabled={!employee || !at || needsReason} onClick={() => punch.mutate()}>Record punch</Button>
      </>}>
      <div className="space-y-3">
        <FieldWrap label="Employee" required>
          <RefPicker refName="employees.employees" value={employee} label={label} filter={{ status: 'Active' }} placeholder="Search by name or code…"
            onChange={(id, row) => { setEmployee(id); setLabel(row ? `${row.title ?? row.label} · ${row.code}` : undefined) }} />
        </FieldWrap>
        <div className="grid grid-cols-2 gap-3">
          <FieldWrap label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}>
              {SOURCES.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </FieldWrap>
          <FieldWrap label="Time" required>
            <Input type="datetime-local" value={at} max={nowLocal()} onChange={(e) => setAt(e.target.value)} />
          </FieldWrap>
        </div>
        <FieldWrap label="Reason" required={source === 'Manual'} help="Manual punches are audited — e.g. terminal down, forgot ID card, emergency call-in.">
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={300} />
        </FieldWrap>
        <p className="text-xs text-ink-3">The first punch of the day is the check-in; later punches set the check-out. A morning punch closes the previous night shift.</p>
      </div>
    </Modal>
  )
}
