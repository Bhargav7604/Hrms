import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addMonths, format, getISODay, isToday, parseISO } from 'date-fns'
import { ChevronLeft, ChevronRight, ExternalLink, Lock, Megaphone, PlayCircle, ShieldCheck } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { FieldInput, RefPicker } from '@/components/fields'
import {
  Avatar, Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, KeyValue, Select, Spinner, StatTile, StatusBadge, Tabs, Textarea,
} from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { date, dateTime, money, number, time, todayISO } from '@/lib/format'
import type { FieldDef, Rec } from '@/lib/types'
import type { BespokeProps } from './index'
import { PayslipModal } from './payroll-console'

// ------------------------------------------------------------------ types

interface Balance { type: string; short: string; entitled: number; used: number; pending: number; available: number }
interface ShiftInfo { id?: string; name?: string; label?: string; start_time?: string; end_time?: string; shift_type?: string }
interface Me {
  employee: Rec & { name: string; code: string; designation?: string; category?: string; doj?: string; phone?: string; email?: string }
  department?: string | null; ward?: string | null
  manager?: { name?: string; designation?: string; phone?: string; email?: string; department?: string | null } | null
  leave_balances: Balance[]
  licence?: { valid_until: string; days_left: number; status: string } | null
  today: { attendance?: Rec | null }
  next_shift?: (ShiftInfo & { date: string }) | null
  service_years?: number | null
}
type Tab = 'overview' | 'leave' | 'attendance' | 'payslips' | 'roster' | 'grievances' | 'posh' | 'requests' | 'training' | 'health'
const TABS: Tab[] = ['overview', 'leave', 'attendance', 'payslips', 'roster', 'grievances', 'posh', 'requests', 'training', 'health']

const GRIEVANCE_CATEGORIES = ['Pay & Benefits', 'Workload', 'Shift / Roster', 'Workplace Safety', 'Harassment (non-POSH)', 'Facilities', 'Other']
const REQUEST_TYPES = ['Salary Certificate', 'Experience Letter', 'ID Card', 'Address Change', 'Bank Change', 'Advance', 'Other']
const FILE = (key: string, label: string): FieldDef => ({ key, label, type: 'file' })
const SHIFT_TONE: Record<string, string> = {
  Morning: 'bg-sky-100 text-sky-900 dark:bg-sky-500/25 dark:text-sky-100', Evening: 'bg-amber-100 text-amber-900 dark:bg-amber-500/25 dark:text-amber-100',
  Night: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-500/30 dark:text-indigo-100', General: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-100',
}
const shiftChip = (s: ShiftInfo) => SHIFT_TONE[s.shift_type ?? ''] ?? 'bg-slate-200 text-slate-900 dark:bg-slate-500/30 dark:text-slate-100'

function useInvalidate() {
  const qc = useQueryClient()
  return (...keys: string[][]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }))
}

// ------------------------------------------------------------------ page

export default function SelfService(_: BespokeProps) {
  const me = useQuery({ queryKey: ['x', 'ess', 'me'], queryFn: () => api<Me>('/ess/me'), retry: (n, e) => !(e instanceof ApiError && e.status === 403) && n < 2 })
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'overview') as Tab
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }) }
  if (me.isLoading) return <Spinner />
  if (me.error) {
    return me.error instanceof ApiError && me.error.status === 403
      ? <Card><Empty icon="UserX" title="No employee profile linked to your login">{me.error.message}</Empty></Card>
      : <ErrorBox error={me.error} />
  }
  const m = me.data!
  return (
    <div className="space-y-3">
      <ProfileCard me={m} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {m.leave_balances.map((b) => (
          <StatTile key={b.type} label={`${b.type} leave (${b.short})`} value={<span className="tabular">{number(b.available)}<span className="text-sm font-normal text-ink-3"> / {b.entitled}</span></span>}
            hint={`${number(b.used)} taken${b.pending ? ` · ${number(b.pending)} pending` : ''} · ${new Date().getFullYear()}`} icon="CalendarCheck"
            onClick={() => setTab('leave')} />
        ))}
        <StatTile label="Today" icon="Fingerprint" onClick={() => setTab('attendance')}
          value={<TodayStatus a={m.today.attendance} />}
          hint={m.next_shift ? `Next shift ${format(parseISO(m.next_shift.date), 'EEE dd MMM')} · ${m.next_shift.label} ${m.next_shift.start_time ?? ''}` : 'No published shift in the next 2 weeks'} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview', icon: 'LayoutDashboard' },
        { key: 'leave', label: 'Leave', icon: 'CalendarCheck' },
        { key: 'attendance', label: 'Attendance', icon: 'CalendarDays' },
        { key: 'payslips', label: 'Payslips', icon: 'BadgeIndianRupee' },
        { key: 'roster', label: 'My roster', icon: 'CalendarClock' },
        { key: 'training', label: 'Training', icon: 'GraduationCap' },
        { key: 'grievances', label: 'Grievances', icon: 'MessageSquareWarning' },
        { key: 'posh', label: 'POSH', icon: 'ShieldCheck' },
        { key: 'requests', label: 'HR requests', icon: 'FileText' },
        { key: 'health', label: 'Staff health', icon: 'HeartPulse' },
      ]} />
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'leave' && <LeaveTab me={m} />}
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'payslips' && <PayslipsTab />}
      {tab === 'roster' && <RosterTab days={14} />}
      {tab === 'training' && <TrainingTab />}
      {tab === 'grievances' && <GrievanceTab />}
      {tab === 'posh' && <PoshTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'health' && <HealthTab />}
    </div>
  )
}

function TodayStatus({ a }: { a?: Rec | null }) {
  if (!a) return <span className="text-base font-medium text-ink-3">No punch yet</span>
  if (a.check_in) {
    return <span className="text-base font-semibold">In {time(a.check_in)}{a.check_out ? ` · Out ${time(a.check_out)}` : ''}</span>
  }
  return <span className="text-base font-semibold">{a.status}</span>
}

function ProfileCard({ me }: { me: Me }) {
  const e = me.employee
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-4">
        <Avatar name={e.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{e.name}</h2>
            <span className="font-mono text-xs text-ink-3">{e.code}</span>
            <StatusBadge status={e.status} />
            {me.licence && (
              <Badge tone={me.licence.status === 'Valid' ? 'green' : me.licence.status === 'Expiring' ? 'amber' : 'red'}>
                Licence {me.licence.status.toLowerCase()} · {date(me.licence.valid_until)}
              </Badge>
            )}
          </div>
          <p className="text-sm text-ink-2">{[e.designation, me.department, me.ward].filter(Boolean).join(' · ')}</p>
          <div className="mt-3">
            <KeyValue cols={3} items={[
              { label: 'Reporting to', value: me.manager ? <>{me.manager.name}<span className="block text-xs text-ink-3">{[me.manager.designation, me.manager.phone].filter(Boolean).join(' · ')}</span></> : '—' },
              { label: 'Date of joining', value: e.doj ? <>{date(e.doj)}{me.service_years !== null && me.service_years !== undefined ? <span className="text-ink-3"> · {me.service_years} yrs</span> : null}</> : '—' },
              { label: 'Employment', value: [e.employment_type, e.category].filter(Boolean).join(' · ') || '—' },
              { label: 'Contact', value: [e.phone, e.email].filter(Boolean).join(' · ') || '—' },
              { label: 'PF UAN · ESI', value: [e.uan, e.esi_no].filter(Boolean).join(' · ') || '—' },
              { label: 'Salary account', value: e.bank_account ? `${e.bank_account}${e.ifsc ? ` · ${e.ifsc}` : ''}` : '—' },
            ]} />
          </div>
        </div>
      </div>
      <p className="mt-3 border-t border-line pt-2 text-xs text-ink-3">Something wrong? Raise an HR request (address or bank change) — HR updates your record after verification.</p>
    </Card>
  )
}

// ------------------------------------------------------------------ overview

function Overview({ go }: { go: (t: Tab) => void }) {
  const ann = useQuery({ queryKey: ['x', 'ess', 'announcements'], queryFn: () => api<Rec[]>('/ess/announcements') })
  const training = useQuery({ queryKey: ['x', 'training', 'ess-training'], queryFn: () => api<TrainingResp>('/ess/training') })
  const due = (training.data?.rows ?? []).filter((r) => r.mandatory && r.compliance !== 'Compliant')
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card title="My next shifts" icon="CalendarClock" actions={<Button size="xs" variant="ghost" onClick={() => go('roster')}>Full roster</Button>} pad={false}>
        <RosterList days={7} compact />
      </Card>
      <div className="space-y-3">
        <Card title="Announcements" icon="Megaphone">
          {ann.isLoading ? <Spinner /> : !ann.data?.length ? <Empty icon="Megaphone" title="No announcements" /> : (
            <ul className="space-y-3">
              {ann.data.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <Megaphone className="mt-0.5 size-4 shrink-0 text-brand-700 dark:text-brand-300" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">{a.title}</div>
                    <p className="line-clamp-3 whitespace-pre-wrap text-sm text-ink-2">{a.body}</p>
                    <p className="text-xs text-ink-3">{date(a.publish_on)}{a.expires_on ? ` · until ${date(a.expires_on)}` : ''}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Mandatory training" icon="GraduationCap" actions={<Button size="xs" variant="ghost" onClick={() => go('training')}>Details</Button>}>
          {training.isLoading ? <Spinner /> : training.data?.compliance_pct === null || training.data?.compliance_pct === undefined
            ? <Empty icon="GraduationCap" title="No mandatory training assigned" />
            : (
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-semibold text-ink">{training.data.compliance_pct}%</span>
                  <span className="text-xs text-ink-3">{training.data.compliant} of {training.data.mandatory} compliant</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <div className={cn('h-full', training.data.compliance_pct >= 90 ? 'bg-emerald-500' : training.data.compliance_pct >= 60 ? 'bg-amber-400' : 'bg-red-500')} style={{ width: `${training.data.compliance_pct}%` }} />
                </div>
                {due.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {due.slice(0, 4).map((r) => <li key={r.course_id} className="flex justify-between gap-2"><span className="truncate text-ink-2">{r.course}</span><ComplianceBadge c={r.compliance} /></li>)}
                  </ul>
                )}
              </div>
            )}
        </Card>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ leave

function LeaveTab({ me }: { me: Me }) {
  const inv = useInvalidate()
  const q = useQuery({ queryKey: ['x', 'roster', 'ess-leaves'], queryFn: () => api<{ rows: Rec[]; refs: Record<string, string>; balances: Balance[]; types: string[] }>('/ess/leaves') })
  const [form, setForm] = useState<{ leave_type: string; from_date: string; to_date: string; half_day: boolean; reason: string; handover_to: string | null; attachment: string | null }>(
    { leave_type: 'Casual', from_date: todayISO(), to_date: todayISO(), half_day: false, reason: '', handover_to: null, attachment: null })
  const days = useMemo(() => {
    if (!form.from_date || !form.to_date) return 0
    const d = (parseISO(form.to_date).getTime() - parseISO(form.from_date).getTime()) / 864e5 + 1
    return d < 1 ? 0 : form.half_day ? 0.5 : d
  }, [form])
  const bal = (q.data?.balances ?? me.leave_balances).find((b) => b.type === form.leave_type)
  const needsCert = (form.leave_type === 'Sick' && days > 2) || form.leave_type === 'Maternity'
  const apply = useMutation({
    mutationFn: () => api<Rec>('/ess/leaves', { method: 'POST', body: { ...form, reason: form.reason || undefined } }),
    onSuccess: (r) => {
      toast.success(`Leave ${r.code} applied for ${number(r.days)} day(s) — sent for approval`)
      setForm({ ...form, reason: '', attachment: null })
      inv(['x', 'roster'], ['x', 'ess', 'me'])
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api<Rec>(`/ess/leaves/${id}/cancel`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(`${r.code} cancelled`); inv(['x', 'roster'], ['x', 'ess', 'me']) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); apply.mutate() }
  return (
    <div className="grid gap-3 lg:grid-cols-[380px_minmax(0,1fr)]">
      <Card title="Apply for leave" icon="CalendarPlus">
        <form className="space-y-3" onSubmit={submit}>
          <FieldWrap label="Leave type" required>
            <Select value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
              {(q.data?.types ?? ['Casual', 'Sick', 'Earned']).map((t) => <option key={t}>{t}</option>)}
            </Select>
          </FieldWrap>
          <div className="grid grid-cols-2 gap-3">
            <FieldWrap label="From" required><Input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value, to_date: form.to_date < e.target.value ? e.target.value : form.to_date })} /></FieldWrap>
            <FieldWrap label="To" required><Input type="date" value={form.to_date} min={form.from_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} /></FieldWrap>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="size-4 accent-brand-700" checked={form.half_day} disabled={form.from_date !== form.to_date}
              onChange={(e) => setForm({ ...form, half_day: e.target.checked })} />
            Half day {form.from_date !== form.to_date && <span className="text-xs text-ink-3">(single date only)</span>}
          </label>
          <div className={cn('rounded-lg px-3 py-2 text-sm', bal && days > bal.available ? 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200' : 'bg-surface-2 text-ink-2')}>
            <b className="text-ink">{number(days)}</b> calendar day{days === 1 ? '' : 's'}
            {bal ? <> · {number(bal.available)} {bal.short} available{days > bal.available ? ' — not enough balance' : ''}</> : null}
          </div>
          <FieldWrap label="Reason"><Textarea rows={2} value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></FieldWrap>
          <FieldWrap label="Hand over duties to">
            <RefPicker refName="employees.employees" value={form.handover_to} filter={{ status: 'Active' }} placeholder="Colleague covering for you" onChange={(id) => setForm({ ...form, handover_to: id })} />
          </FieldWrap>
          <FieldWrap label="Medical certificate / document" required={needsCert} help={needsCert ? 'Required for sick leave beyond 2 days and for maternity leave' : undefined}>
            <FieldInput field={FILE('attachment', 'Document')} value={form.attachment} onChange={(v) => setForm({ ...form, attachment: (v as string) ?? null })} />
          </FieldWrap>
          <Button type="submit" variant="primary" className="w-full" loading={apply.isPending} disabled={!days || (needsCert && !form.attachment)}>Apply</Button>
        </form>
      </Card>
      <Card title="My leave" icon="History" pad={false}>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-3"><ErrorBox error={q.error} /></div> : !q.data?.rows.length ? <Empty icon="CalendarCheck" title="No leave applied yet" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2">
                <tr>{['Leave', 'Dates', 'Days', 'Status', 'Remarks', ''].map((h) => <th key={h} className="border-b border-line px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2"><div className="font-medium text-ink">{r.leave_type}</div><div className="font-mono text-xs text-ink-3">{r.code}</div></td>
                    <td className="whitespace-nowrap px-3 py-2 tabular">{date(r.from_date)}{r.to_date !== r.from_date ? ` – ${date(r.to_date)}` : ''}</td>
                    <td className="tabular px-3 py-2">{number(r.days)}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    <td className="max-w-xs px-3 py-2 text-xs text-ink-2">
                      {r.reason}{r.handover_to ? <span className="block text-ink-3">Cover: {q.data.refs[r.handover_to] ?? '—'}</span> : null}
                      {r.approver_remarks ? <span className="block italic">“{r.approver_remarks}”</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.can_cancel && <Button size="xs" variant="ghost" className="text-red-600" loading={cancel.isPending && cancel.variables === r.id}
                        onClick={() => { if (confirm(`Cancel ${r.leave_type.toLowerCase()} leave ${r.code}?`)) cancel.mutate(r.id) }}>Cancel</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ attendance calendar

interface AttDay { date: string; weekday: string; attendance?: Rec | null; shifts: string[]; leave?: { leave_type: string; short?: string; status: string } | null }
interface AttResp { month: string; days: AttDay[]; summary: Record<string, number> }

const ATT_CODE: Record<string, { code: string; cls: string }> = {
  Present: { code: 'P', cls: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' },
  'Half Day': { code: '½', cls: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' },
  Absent: { code: 'A', cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' },
  'On Leave': { code: 'L', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300' },
  Holiday: { code: 'H', cls: 'bg-violet-50 text-violet-800 dark:bg-violet-500/10 dark:text-violet-300' },
  'Weekly Off': { code: 'WO', cls: 'bg-surface-2 text-ink-2' },
}

function AttendanceTab() {
  const [month, setMonth] = useState(() => format(new Date(), 'yyyy-MM'))
  const q = useQuery({ queryKey: ['x', 'roster', 'ess-attendance', month], queryFn: () => api<AttResp>('/ess/attendance', { query: { month } }), placeholderData: (p) => p })
  const first = parseISO(`${month}-01`)
  const lead = getISODay(first) - 1
  const s = q.data?.summary
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-line-2 bg-surface shadow-sm">
          <button className="rounded-l-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Previous month" onClick={() => setMonth(format(addMonths(first, -1), 'yyyy-MM'))}><ChevronLeft className="size-4" /></button>
          <span className="min-w-36 px-2 text-center text-sm font-medium text-ink">{format(first, 'MMMM yyyy')}</span>
          <button className="rounded-r-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Next month" onClick={() => setMonth(format(addMonths(first, 1), 'yyyy-MM'))}><ChevronRight className="size-4" /></button>
        </div>
        {s && (
          <div className="ml-auto flex flex-wrap gap-1.5 text-xs">
            <Badge tone="green">{s.present} present</Badge>
            {s.half_day > 0 && <Badge tone="amber">{s.half_day} half day</Badge>}
            {s.absent > 0 && <Badge tone="red">{s.absent} absent</Badge>}
            {s.on_leave > 0 && <Badge tone="gray">{s.on_leave} on leave</Badge>}
            {s.late_days > 0 && <Badge tone="amber">{s.late_days} late ({s.late_minutes} min)</Badge>}
            <Badge tone="blue">{s.hours} h worked</Badge>
            {s.overtime_hours > 0 && <Badge tone="violet">{s.overtime_hours} h overtime</Badge>}
          </div>
        )}
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading ? <Spinner /> : q.data && (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="grid grid-cols-7 border-b border-line bg-surface-2 text-center text-xs font-medium text-ink-2">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-1.5">{d}</div>)}
          </div>
          <div className={cn('grid grid-cols-7', q.isFetching && 'opacity-70')}>
            {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} className="min-h-24 border-b border-r border-line bg-surface-2/50" />)}
            {q.data.days.map((d) => {
              const a = d.attendance
              const st = a?.status ? ATT_CODE[a.status] : undefined
              return (
                <div key={d.date} className={cn('min-h-24 border-b border-r border-line p-1.5 text-xs', isToday(parseISO(d.date)) && 'bg-brand-50 dark:bg-brand-500/10')}>
                  <div className="flex items-center justify-between">
                    <span className={cn('tabular font-medium', isToday(parseISO(d.date)) ? 'text-brand-800 dark:text-brand-200' : 'text-ink')}>{Number(d.date.slice(8))}</span>
                    <span className="flex gap-0.5">{d.shifts.map((s, i) => <span key={i} className="rounded bg-surface-2 px-1 font-semibold text-ink-2 ring-1 ring-line">{s}</span>)}</span>
                  </div>
                  {a && st && (
                    <div className={cn('mt-1 rounded px-1 py-0.5', st.cls)} title={a.status}>
                      <span className="font-semibold">{st.code}</span> <span className="sr-only">{a.status}</span>
                      {a.check_in && <span className="tabular"> {time(a.check_in)}–{a.check_out ? time(a.check_out) : '…'}</span>}
                    </div>
                  )}
                  {a && a.late_minutes > 0 && <div className="mt-0.5 text-amber-700 dark:text-amber-300">Late {a.late_minutes} min</div>}
                  {a?.hours_worked ? <div className="text-ink-3">{a.hours_worked} h{a.overtime_hours ? ` · OT ${a.overtime_hours}` : ''}</div> : null}
                  {d.leave && !a && <div className="mt-1 rounded bg-surface-2 px-1 py-0.5 text-ink-2">{d.leave.short ?? 'Leave'} · {d.leave.status}</div>}
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-3 border-t border-line px-3 py-2 text-[11px] text-ink-3">
            {Object.entries(ATT_CODE).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1"><span className={cn('rounded px-1 font-semibold', v.cls)}>{v.code}</span>{k}</span>)}
            <span>· shift codes at the top right of each day</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ payslips

function PayslipsTab() {
  const q = useQuery({ queryKey: ['x', 'payroll', 'ess-payslips'], queryFn: () => api<Rec[]>('/ess/payslips') })
  const [open, setOpen] = useState<string | null>(null)
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  return (
    <Card title="My payslips" icon="BadgeIndianRupee" pad={false}>
      {!q.data?.length ? <Empty icon="BadgeIndianRupee" title="No payslips published yet">Payslips appear here once HR publishes the month's payroll.</Empty> : (
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-ink-2">
            <tr>{['Month', 'Paid days', 'Gross', 'Deductions', 'Net pay', ''].map((h, i) => <th key={h} className={cn('border-b border-line px-3 py-2 font-medium', i >= 2 && i <= 4 ? 'text-right' : 'text-left')}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {q.data.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                <td className="px-3 py-2"><div className="font-medium text-ink">{format(parseISO(`${p.period}-01`), 'MMMM yyyy')}</div><div className="font-mono text-xs text-ink-3">{p.code}</div></td>
                <td className="tabular px-3 py-2">{number(p.paid_days)} / {p.days_in_month}{p.lop_days > 0 && <span className="ml-1 text-xs text-red-700 dark:text-red-300">({number(p.lop_days)} LOP)</span>}</td>
                <td className="tabular px-3 py-2 text-right">{money(p.gross)}</td>
                <td className="tabular px-3 py-2 text-right">{money(p.total_deductions)}</td>
                <td className="tabular px-3 py-2 text-right font-semibold text-ink">{money(p.net_pay)}</td>
                <td className="px-3 py-2 text-right"><Button size="xs" onClick={() => setOpen(p.id)}>View / print</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <PayslipModal slipId={open} source="ess" onClose={() => setOpen(null)} />}
    </Card>
  )
}

// ------------------------------------------------------------------ roster

interface RosterDay { date: string; weekday: string; shifts: (ShiftInfo & { ward?: string | null; role_on_duty?: string | null; status?: string })[]; leave?: { leave_type: string; status: string } | null }

function RosterList({ days, compact }: { days: number; compact?: boolean }) {
  const q = useQuery({ queryKey: ['x', 'roster', 'ess-roster', days], queryFn: () => api<{ days: RosterDay[] }>('/ess/roster', { query: { days } }) })
  if (q.isLoading) return <Spinner />
  if (q.error) return <div className="p-3"><ErrorBox error={q.error} /></div>
  return (
    <ul className="divide-y divide-line">
      {q.data?.days.map((d) => (
        <li key={d.date} className={cn('flex items-center gap-3 px-4', compact ? 'py-1.5' : 'py-2.5', isToday(parseISO(d.date)) && 'bg-brand-50/60 dark:bg-brand-500/10')}>
          <div className="w-20 shrink-0">
            <div className="text-xs text-ink-3">{d.weekday}{isToday(parseISO(d.date)) ? ' · today' : ''}</div>
            <div className="tabular text-sm font-medium text-ink">{format(parseISO(d.date), 'dd MMM')}</div>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {d.shifts.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-2">
                <span className={cn('inline-flex h-6 min-w-7 items-center justify-center rounded px-1.5 text-xs font-semibold', shiftChip(s))}>{s.label}</span>
                <span className="text-sm text-ink">{s.name} <span className="tabular text-ink-3">{s.start_time}–{s.end_time}</span></span>
                {!compact && (s.ward || s.role_on_duty) && <span className="text-xs text-ink-3">{[s.ward, s.role_on_duty].filter(Boolean).join(' · ')}</span>}
                {s.status === 'Swapped' && <Badge tone="violet">Swapped</Badge>}
              </span>
            ))}
            {d.leave && <Badge tone={d.leave.status === 'Approved' ? 'amber' : 'gray'}>{d.leave.leave_type} leave · {d.leave.status}</Badge>}
            {!d.shifts.length && !d.leave && <span className="text-sm text-ink-3">Off / not rostered</span>}
          </div>
        </li>
      ))}
    </ul>
  )
}

function RosterTab({ days }: { days: number }) {
  return (
    <Card title={`My roster · next ${days} days`} icon="CalendarClock" pad={false}>
      <RosterList days={days} />
      <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Only published shifts are shown. For a swap, agree with a colleague and ask your ward in-charge to update the roster.</p>
    </Card>
  )
}

// ------------------------------------------------------------------ training & health

interface TrainingRow {
  course_id: string; course: string; category?: string; mode?: string; video_url?: string | null; duration_minutes?: number | null; mandatory: boolean
  regulatory_basis?: string | null; status?: string | null; due_date?: string | null; completed_on?: string | null; valid_until?: string | null
  score?: number | null; compliance: 'Compliant' | 'Expired' | 'Overdue' | 'Due' | 'Not assigned'
}
interface TrainingResp { rows: TrainingRow[]; compliance_pct: number | null; mandatory?: number; compliant?: number }

function ComplianceBadge({ c }: { c: TrainingRow['compliance'] }) {
  const tone = c === 'Compliant' ? 'green' : c === 'Due' || c === 'Not assigned' ? 'amber' : 'red'
  return <Badge tone={tone} dot>{c}</Badge>
}

function TrainingTab() {
  const q = useQuery({ queryKey: ['x', 'training', 'ess-training'], queryFn: () => api<TrainingResp>('/ess/training') })
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  const d = q.data!
  return (
    <Card title="Mandatory training compliance" icon="GraduationCap" pad={false}
      actions={d.compliance_pct !== null ? <Badge tone={d.compliance_pct >= 90 ? 'green' : d.compliance_pct >= 60 ? 'amber' : 'red'}>{d.compliance_pct}% compliant</Badge> : undefined}>
      {!d.rows.length ? <Empty icon="GraduationCap" title="No training assigned">HR assigns mandatory courses (NABH, BLS, fire safety, infection control, POSH) for your role.</Empty> : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-2">
              <tr>{['Course', 'Due', 'Completed', 'Valid until', 'Score', 'Compliance'].map((h) => <th key={h} className="border-b border-line px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.course_id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 font-medium text-ink">
                      {r.course}{r.mandatory && <Badge tone="violet">Mandatory</Badge>}
                    </div>
                    <div className="text-xs text-ink-3">{[r.category, r.mode, r.duration_minutes ? `${r.duration_minutes} min` : null, r.regulatory_basis].filter(Boolean).join(' · ')}</div>
                    {r.video_url && /^https?:\/\//.test(r.video_url) && (
                      <a href={r.video_url} target="_blank" rel="noreferrer noopener" className="mt-0.5 inline-flex items-center gap-1 text-xs text-brand-700 hover:underline dark:text-brand-300">
                        <PlayCircle className="size-3.5" />Watch training video<ExternalLink className="size-3" />
                      </a>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular">{date(r.due_date)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular">{date(r.completed_on)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular">{date(r.valid_until)}</td>
                  <td className="tabular px-3 py-2">{r.score !== null && r.score !== undefined ? `${r.score}%` : '—'}</td>
                  <td className="px-3 py-2"><ComplianceBadge c={r.compliance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function HealthTab() {
  const q = useQuery({ queryKey: ['x', 'occhealth', 'ess-health'], queryFn: () => api<{ checks: Rec[]; vaccinations: Rec[] }>('/ess/health') })
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  const { checks, vaccinations } = q.data!
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="Health checks" icon="Stethoscope" pad={false}>
        {!checks.length ? <Empty icon="Stethoscope" title="No health checks on record" /> : (
          <ul className="divide-y divide-line">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div>
                  <div className="font-medium text-ink">{c.check_type}</div>
                  <div className="text-xs text-ink-3">{date(c.check_date)}{c.fitness ? ` · ${c.fitness}` : ''}{c.restrictions ? ` · ${c.restrictions}` : ''}</div>
                  {c.next_due && <div className="text-xs text-ink-2">Next due {date(c.next_due)}</div>}
                </div>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Vaccinations" icon="Syringe" pad={false}>
        {!vaccinations.length ? <Empty icon="Syringe" title="No vaccinations on record" /> : (
          <ul className="divide-y divide-line">
            {vaccinations.map((v) => (
              <li key={v.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div>
                  <div className="font-medium text-ink">{v.vaccine} · {v.dose}</div>
                  <div className="text-xs text-ink-3">{v.given_on ? `Given ${date(v.given_on)}` : `Due ${date(v.due_date)}`}{v.next_dose_due ? ` · next dose ${date(v.next_dose_due)}` : ''}</div>
                </div>
                <StatusBadge status={v.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-ink-3 lg:col-span-2">Needle-stick and body-fluid exposure records are confidential and handled by the occupational health team — report an exposure immediately to the emergency department.</p>
    </div>
  )
}

// ------------------------------------------------------------------ grievances

function GrievanceTab() {
  const inv = useInvalidate()
  const q = useQuery({ queryKey: ['x', 'ess', 'grievances'], queryFn: () => api<Rec[]>('/ess/grievances') })
  const [f, setF] = useState({ category: 'Workload', severity: 'Medium', description: '', anonymous: false, attachment: null as string | null })
  const raise = useMutation({
    mutationFn: () => api<Rec>('/ess/grievances', { method: 'POST', body: f }),
    onSuccess: (r) => { toast.success(`Grievance ${r.code} submitted`); setF({ ...f, description: '', attachment: null, anonymous: false }); inv(['x', 'ess', 'grievances']) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const feedback = useMutation({
    mutationFn: (v: { id: string; feedback: string; reopen: boolean }) => api<Rec>(`/ess/grievances/${v.id}/feedback`, { method: 'POST', body: v }),
    onSuccess: (r) => { toast.success(r.status === 'Closed' ? 'Thank you — grievance closed' : 'Grievance re-opened for review'); inv(['x', 'ess', 'grievances']) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="grid gap-3 lg:grid-cols-[380px_minmax(0,1fr)]">
      <Card title="Raise a grievance" icon="MessageSquareWarning">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); raise.mutate() }}>
          <div className="grid grid-cols-2 gap-3">
            <FieldWrap label="Category" required>
              <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{GRIEVANCE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select>
            </FieldWrap>
            <FieldWrap label="Severity">
              <Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['Low', 'Medium', 'High'].map((c) => <option key={c}>{c}</option>)}</Select>
            </FieldWrap>
          </div>
          <FieldWrap label="What happened?" required help="At least 10 characters. Sexual harassment complaints go to the POSH tab instead.">
            <Textarea rows={5} value={f.description} maxLength={5000} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Attachment"><FieldInput field={FILE('attachment', 'Attachment')} value={f.attachment} onChange={(v) => setF({ ...f, attachment: (v as string) ?? null })} /></FieldWrap>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} />
            <span>Hide my identity from reviewers<span className="block text-xs text-ink-3">Reviewers see the grievance but not who raised it. You can still follow it here.</span></span>
          </label>
          <Button type="submit" variant="primary" className="w-full" loading={raise.isPending} disabled={f.description.trim().length < 10}>Submit grievance</Button>
        </form>
      </Card>
      <Card title="My grievances" icon="History" pad={false}>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-3"><ErrorBox error={q.error} /></div> : !q.data?.length ? <Empty icon="MessageSquare" title="No grievances raised" /> : (
          <ul className="divide-y divide-line">
            {q.data.map((g) => (
              <li key={g.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{g.category}</span>
                    <span className="font-mono text-xs text-ink-3">{g.code}</span>
                    <Badge tone={g.severity === 'High' ? 'red' : g.severity === 'Medium' ? 'amber' : 'gray'}>{g.severity}</Badge>
                    {g.anonymous && <Badge tone="violet"><Lock className="size-3" />Anonymous</Badge>}
                  </div>
                  <StatusBadge status={g.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-2">{g.description}</p>
                <p className="text-xs text-ink-3">Raised {dateTime(g.created_at)}</p>
                {g.resolution && <p className="mt-1 rounded-md bg-surface-2 px-2 py-1 text-sm text-ink"><b>Resolution:</b> {g.resolution}</p>}
                {g.status === 'Resolved' && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-ink-2">Are you satisfied?</span>
                    {['Satisfied', 'Partly satisfied'].map((fb) => (
                      <Button key={fb} size="xs" loading={feedback.isPending} onClick={() => feedback.mutate({ id: g.id, feedback: fb, reopen: false })}>{fb} — close</Button>
                    ))}
                    <Button size="xs" variant="ghost" className="text-red-600" onClick={() => feedback.mutate({ id: g.id, feedback: 'Not satisfied', reopen: true })}>Not satisfied — re-open</Button>
                  </div>
                )}
                {g.employee_feedback && <p className="mt-1 text-xs text-ink-3">Your feedback: {g.employee_feedback}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ POSH

function PoshTab() {
  const inv = useInvalidate()
  const mine = useQuery({ queryKey: ['x', 'ess', 'posh'], queryFn: () => api<Rec[]>('/ess/posh') })
  const blank = { respondent: null as string | null, respondent_external: '', incident_date: '', incident_location: '', description: '', witnesses: '', evidence: null as string | null }
  const [f, setF] = useState(blank)
  const [ack, setAck] = useState(false)
  const file = useMutation({
    mutationFn: () => api<Rec>('/ess/posh', { method: 'POST', body: { ...f, respondent_external: f.respondent_external || undefined, incident_location: f.incident_location || undefined, witnesses: f.witnesses || undefined } }),
    onSuccess: (r) => { toast.success(`Complaint ${r.code} filed with the Internal Committee`); setF(blank); setAck(false); inv(['x', 'ess', 'posh']) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const ok = ack && f.incident_date && f.description.trim().length >= 20 && (f.respondent || f.respondent_external.trim())
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <Card title="How the Internal Committee handles a complaint" icon="ShieldCheck">
          <div className="space-y-3 text-sm text-ink-2">
            <p>Under the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013, the hospital's
              <b className="text-ink"> Internal Committee (IC)</b> — chaired by a senior woman employee and including an external member from an NGO or
              legal background — inquires into complaints of sexual harassment at the workplace, including by patients, attendants or vendor staff.</p>
            <ol className="space-y-2">
              {([
                ['File', 'Within 3 months of the incident (or the last incident in a series). The IC can extend this by 3 months if there were reasons you could not file sooner.'],
                ['Conciliation (optional)', 'Only if you ask for it. No monetary settlement can be the basis of conciliation.'],
                ['Interim relief', 'While the inquiry is on, you may request a transfer, leave of up to 3 months, or that the respondent not supervise your work.'],
                ['Inquiry', 'The respondent receives a copy within 7 working days and replies within 10 days. Both sides are heard; the inquiry is completed within 90 days.'],
                ['Report and action', 'The IC reports to management within 10 days of finishing; management must act on its recommendations within 60 days.'],
              ] as [string, string][]).map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-800 ring-1 ring-brand-700/15 dark:bg-brand-500/10 dark:text-brand-200">{i + 1}</span>
                  <span><b className="text-ink">{t}.</b> {d}</span>
                </li>
              ))}
            </ol>
            <p className="flex gap-2 rounded-lg bg-surface-2 p-2.5 text-xs">
              <Lock className="mt-0.5 size-4 shrink-0 text-brand-700 dark:text-brand-300" />
              <span><b className="text-ink">Confidential (s.16).</b> Your complaint goes only to the Internal Committee. Your identity, the respondent's, witnesses and proceedings may not be
                published or disclosed. Here you will only see the stage of your complaint. Retaliation against a complainant or witness is misconduct.</span>
            </p>
            <p className="text-xs text-ink-3">Not sure, or need someone to talk to first? Speak to any IC member in confidence. In an emergency call hospital security or 112.</p>
          </div>
        </Card>
        <Card title="My complaints" icon="History" pad={false}>
          {mine.isLoading ? <Spinner /> : mine.error ? <div className="p-3"><ErrorBox error={mine.error} /></div> : !mine.data?.length ? <Empty icon="ShieldCheck" title="No complaints filed" /> : (
            <ul className="divide-y divide-line">
              {mine.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <div>
                    <div className="font-medium text-ink">{c.stage}</div>
                    <div className="text-xs text-ink-3"><span className="font-mono">{c.code}</span> · filed {date(c.filed_on)} · inquiry due by {date(c.inquiry_due)}</div>
                  </div>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="File a confidential complaint" icon="ShieldAlert">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) file.mutate() }}>
          <FieldWrap label="Respondent (staff member)" help="Leave blank if the person is not an employee and describe them below.">
            <RefPicker refName="employees.employees" value={f.respondent} filter={{ status: 'Active' }} placeholder="Search staff…" onChange={(id) => setF({ ...f, respondent: id })} />
          </FieldWrap>
          <FieldWrap label="Respondent if not an employee" help="e.g. patient attendant, vendor or contractor staff — name, role, how to identify them">
            <Input value={f.respondent_external} maxLength={300} onChange={(e) => setF({ ...f, respondent_external: e.target.value })} />
          </FieldWrap>
          <div className="grid grid-cols-2 gap-3">
            <FieldWrap label="Date of incident" required><Input type="date" max={todayISO()} value={f.incident_date} onChange={(e) => setF({ ...f, incident_date: e.target.value })} /></FieldWrap>
            <FieldWrap label="Where"><Input value={f.incident_location} maxLength={300} placeholder="Ward, room, area" onChange={(e) => setF({ ...f, incident_location: e.target.value })} /></FieldWrap>
          </div>
          <FieldWrap label="What happened" required help="In your own words: what was said or done, when, and how often. At least 20 characters.">
            <Textarea rows={6} value={f.description} maxLength={20000} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Witnesses"><Textarea rows={2} value={f.witnesses} maxLength={5000} onChange={(e) => setF({ ...f, witnesses: e.target.value })} /></FieldWrap>
          <FieldWrap label="Evidence (messages, photos, documents)"><FieldInput field={FILE('evidence', 'Evidence')} value={f.evidence} onChange={(v) => setF({ ...f, evidence: (v as string) ?? null })} /></FieldWrap>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I understand this complaint is sent to the Internal Committee only, and that I will be contacted by the Committee for the inquiry.</span>
          </label>
          <Button type="submit" variant="primary" className="w-full" loading={file.isPending} disabled={!ok}><ShieldCheck className="size-4" />File complaint</Button>
        </form>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ HR requests

function RequestsTab() {
  const inv = useInvalidate()
  const q = useQuery({ queryKey: ['x', 'ess', 'requests'], queryFn: () => api<Rec[]>('/ess/requests') })
  const [f, setF] = useState({ request_type: 'Salary Certificate', details: '', supporting_document: null as string | null })
  const raise = useMutation({
    mutationFn: () => api<Rec>('/ess/requests', { method: 'POST', body: { ...f, details: f.details || undefined } }),
    onSuccess: (r) => { toast.success(`Request ${r.code} sent to HR`); setF({ ...f, details: '', supporting_document: null }); inv(['x', 'ess', 'requests']) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const needsDetails = ['Address Change', 'Bank Change', 'Other'].includes(f.request_type)
  return (
    <div className="grid gap-3 lg:grid-cols-[380px_minmax(0,1fr)]">
      <Card title="New HR request" icon="FilePlus">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); raise.mutate() }}>
          <FieldWrap label="Request" required>
            <Select value={f.request_type} onChange={(e) => setF({ ...f, request_type: e.target.value })}>{REQUEST_TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
          </FieldWrap>
          <FieldWrap label="Details" required={needsDetails} help={f.request_type === 'Bank Change' ? 'New account number, IFSC and bank — attach a cancelled cheque' : f.request_type === 'Salary Certificate' ? 'Purpose, e.g. home loan from SBI' : undefined}>
            <Textarea rows={4} value={f.details} maxLength={3000} onChange={(e) => setF({ ...f, details: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Supporting document"><FieldInput field={FILE('supporting_document', 'Document')} value={f.supporting_document} onChange={(v) => setF({ ...f, supporting_document: (v as string) ?? null })} /></FieldWrap>
          <Button type="submit" variant="primary" className="w-full" loading={raise.isPending} disabled={needsDetails && !f.details.trim()}>Send to HR</Button>
        </form>
      </Card>
      <Card title="My requests" icon="History" pad={false}>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-3"><ErrorBox error={q.error} /></div> : !q.data?.length ? <Empty icon="FileText" title="No requests yet" /> : (
          <ul className="divide-y divide-line">
            {q.data.map((r) => (
              <li key={r.id} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-ink">{r.request_type} <span className="font-mono text-xs font-normal text-ink-3">{r.code}</span></span>
                  <StatusBadge status={r.status} />
                </div>
                {r.details && <p className="text-ink-2">{r.details}</p>}
                <p className="text-xs text-ink-3">Raised {dateTime(r.created_at)}{r.completed_at ? ` · completed ${dateTime(r.completed_at)}` : ''}</p>
                {r.response && <p className="mt-1 rounded-md bg-surface-2 px-2 py-1 text-ink"><b>HR:</b> {r.response}</p>}
                {r.document && <div className="mt-1"><FieldInput field={FILE('document', 'Issued document')} value={r.document} onChange={() => {}} disabled /></div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
