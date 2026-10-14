import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format, parseISO } from 'date-fns'
import { ChevronLeft, ChevronRight, Search, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { TransitionDialog, useEntity } from '@/components/records'
import {
  Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Kbd, Segmented, Select, Spinner, StatusBadge,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { money, todayISO } from '@/lib/format'
import type { Rec, TransitionDef } from '@/lib/types'
import type { BespokeProps } from './index'

interface Leave { id: string; code: string; reason?: string | null; from_date: string; to_date: string }
interface Appt {
  id: string; code: string; token_no: number | null; slot: string; status: string; type?: string | null
  booking_source?: string | null; appt_date?: string; patient_id?: string; patient?: string | null; uhid?: string | null
  age?: number | null; gender?: string | null; reason?: string | null; checked_in_at?: string | null
  queue_token?: string | null; rescheduled_from?: string | null; overbooked?: boolean | null
}
interface BoardDoctor {
  doctor_id: string; name: string; code: string | null; queue: string | null; department_id: string | null; department: string | null
  room: string | null; sessions: string[]; on_leave: Leave | null; capacity: number; counts: Record<string, number>; active: number
  appointments: Appt[]
}
interface Unit { department_id: string | null; name: string; doctors: number; capacity: number; total: number; by_status: Record<string, number> }
interface Board { date: string; weekday: string; doctors: BoardDoctor[]; units: Unit[]; totals: Record<string, number>; total: number }
type SlotStatus = 'free' | 'booked' | 'past' | 'full' | 'leave'
interface Slot { time: string; status: SlotStatus; session: string; room?: string | null; off_grid?: boolean; appointments: Appt[] }
interface SlotGrid {
  doctor: { id: string; name: string; department?: string | null; consult_fee?: number | null }
  date: string; weekday: string; has_schedule: boolean; on_leave: Leave | null; room?: string | null; mode?: string | null
  consult_fee?: number | null; sessions: { start: string; end: string; slot_minutes?: number; room?: string | null; max_patients?: number | null }[]
  slots: Slot[]; capacity: number; booked: number; free: number
}

const TYPES = ['New', 'Follow-up', 'Review with reports', 'Teleconsult', 'Procedure']
const SOURCES = ['Walk-in', 'Phone', 'Online', 'WhatsApp', 'Health Camp', 'Referral', 'CRM']
const INACTIVE = ['Cancelled', 'No-show']

const SLOT_STYLE: Record<SlotStatus, string> = {
  free: 'border-line-2 bg-surface text-ink hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-500/10',
  booked: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100',
  past: 'border-line bg-surface-2 text-ink-3',
  full: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
  leave: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
}
const SLOT_LABEL: Record<SlotStatus, string> = { free: 'Free', booked: 'Booked', past: 'Past', full: 'Full', leave: 'Leave' }

const shortName = (n?: string | null) => (n ?? '').replace(/^(Mr|Mrs|Ms|Master|Baby|Dr)\.?\s+/i, '').split(' ')[0] || '—'
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)

export default function BookingDesk({ module }: BespokeProps) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const apptEnt = useEntity('appointments.appointments')
  const [params, setParams] = useSearchParams()
  const today = todayISO()
  const date = params.get('date') || today
  const doctorParam = params.get('doctor')
  const [dept, setDept] = useState('')
  const [q, setQ] = useState('')
  const [view, setView] = useState<'doctors' | 'units'>('doctors')
  const [slot, setSlot] = useState<string | null>(null)
  const [selected, setSelected] = useState<Appt | null>(null)
  const [rescheduling, setRescheduling] = useState<(Appt & { doctor: string; date: string }) | null>(null)
  const [patientId, setPatientId] = useState<string | null>(params.get('patient'))
  const [form, setForm] = useState({ type: 'New', booking_source: 'Walk-in', reason: '' })
  const [extra, setExtra] = useState({ on: false, time: '' })
  const [tr, setTr] = useState<{ rec: Rec; t: TransitionDef } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const canWrite = reg.canEntity('appointments.appointments', 'write')
  const role = reg.meta?.user.role
  const canOverbook = role === 'front_office' || role === 'admin'

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v); else p.delete(k)
    setParams(p, { replace: true })
  }
  const setDate = (d: string) => { setParam('date', d === today ? null : d); setSlot(null); setSelected(null) }
  const shift = (n: number) => setDate(format(addDays(parseISO(date), n), 'yyyy-MM-dd'))

  const board = useQuery({
    queryKey: ['x', module.id, 'board', date, dept],
    queryFn: () => api<Board>('/appointments/board', { query: { date, department_id: dept || undefined } }),
    placeholderData: (prev) => prev,
  })
  const doctors = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (board.data?.doctors ?? []).filter((d) => !s || `${d.name} ${d.department ?? ''} ${d.room ?? ''}`.toLowerCase().includes(s))
  }, [board.data, q])
  const doctorId = doctorParam && board.data?.doctors.some((d) => d.doctor_id === doctorParam) ? doctorParam : doctors[0]?.doctor_id ?? null
  const doctor = board.data?.doctors.find((d) => d.doctor_id === doctorId) ?? null

  const grid = useQuery({
    queryKey: ['x', module.id, 'slots', doctorId, date],
    queryFn: () => api<SlotGrid>('/appointments/slots', { query: { doctor_id: doctorId!, date } }),
    enabled: !!doctorId,
  })

  useEffect(() => { setSlot(null); setSelected(null) }, [doctorId, date])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); shift(-1) }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); shift(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['x', module.id] })
  const book = useMutation({
    mutationFn: () => api<Rec>('/appointments/book', {
      method: 'POST',
      body: {
        patient_id: patientId, doctor_id: doctorId, appt_date: date, slot: extra.on ? extra.time : slot, type: form.type,
        booking_source: form.booking_source, reason: form.reason || undefined, overbook: extra.on,
      },
    }),
    onSuccess: (r) => {
      toast.success(`Booked ${r.code} · token ${r.token_no} at ${r.slot}`)
      setSlot(null); setExtra({ on: false, time: '' }); setForm((f) => ({ ...f, reason: '' })); setPatientId(null); setParam('patient', null)
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const move = useMutation({
    mutationFn: () => api<Rec>(`/appointments/${rescheduling!.id}/reschedule`, {
      method: 'POST', body: { appt_date: date, slot: extra.on ? extra.time : slot, doctor_id: doctorId, overbook: extra.on },
    }),
    onSuccess: (r) => { toast.success(`Rescheduled to ${r.appt_date} ${r.slot} · ${r.code}, token ${r.token_no}`); setRescheduling(null); setSlot(null); setExtra({ on: false, time: '' }); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const quick = useMutation({
    mutationFn: ({ a, to }: { a: Appt; to: string }) => api<Rec>(`/m/appointments/appointments/${a.id}/transition`, { method: 'POST', body: { to } }),
    onSuccess: (r, { to }) => {
      toast.success(to === 'Checked-in' ? `${r.code} checked in${r.queue_label ? ` · queue token ${r.queue_label}` : ''}` : `${r.code} → ${to}`)
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const openCancel = (a: Appt) => {
    const t = apptEnt?.transitions.find((x) => x.to === 'Cancelled')
    if (t) setTr({ rec: { ...a, _refs: {} } as Rec, t })
  }
  const startReschedule = (a: Appt) => {
    setRescheduling({ ...a, doctor: doctor?.name ?? '', date })
    setSelected(null); setSlot(null)
    toast.info('Pick the new date, doctor and slot, then confirm')
  }

  const appts = useMemo(() => [...(doctor?.appointments ?? [])].sort((a, b) => (a.token_no ?? 999) - (b.token_no ?? 999)), [doctor])
  const totals = board.data?.totals ?? {}
  const dayLabel = format(parseISO(date), 'EEE, dd MMM yyyy')
  const freeCount = grid.data?.slots.filter((s) => s.status === 'free').length ?? 0
  const slotOrExtra = extra.on ? extra.time : slot

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => shift(-1)} aria-label="Previous day" title="Previous day (Alt+←)"><ChevronLeft className="size-4" /></Button>
          <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-8 w-40" aria-label="Date" />
          <Button size="sm" variant="secondary" onClick={() => shift(1)} aria-label="Next day" title="Next day (Alt+→)"><ChevronRight className="size-4" /></Button>
          {date !== today && <Button size="sm" variant="ghost" onClick={() => setDate(today)}>Today</Button>}
        </div>
        <span className="text-sm font-medium text-ink">{dayLabel}</span>
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="h-8 w-52" aria-label="Department">
          <option value="">All departments</option>
          {(board.data?.units ?? []).map((u) => <option key={u.department_id ?? '-'} value={u.department_id ?? ''}>{u.name}</option>)}
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
          <span className="tabular font-semibold text-ink">{board.data?.total ?? 0}</span> appointments
          {['Booked', 'Checked-in', 'In Consultation', 'Completed', 'No-show', 'Cancelled'].map((s) => totals[s] ? (
            <Badge key={s} tone={s === 'Booked' ? 'amber' : s === 'Completed' ? 'green' : INACTIVE.includes(s) ? 'red' : 'blue'}>{s} {totals[s]}</Badge>
          ) : null)}
        </div>
      </div>

      {rescheduling && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <span>Rescheduling <b>{rescheduling.code}</b> — {rescheduling.patient} (token {rescheduling.token_no}, {rescheduling.date} {rescheduling.slot}, {rescheduling.doctor}). Pick a new date, doctor and free slot.</span>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setRescheduling(null)}><X className="size-3.5" /> Stop</Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
        {/* doctors / units */}
        <Card pad={false} className="h-fit lg:sticky lg:top-4">
          <div className="space-y-2 border-b border-line p-3">
            <Segmented value={view} onChange={setView} options={[{ key: 'doctors', label: `Doctors (${board.data?.doctors.length ?? 0})` }, { key: 'units', label: `Units (${board.data?.units.length ?? 0})` }]} />
            {view === 'doctors' && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
                <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find doctor, unit, room" className="pl-8 pr-8" />
                <span className="absolute right-2 top-2"><Kbd>/</Kbd></span>
              </div>
            )}
          </div>
          <div className="max-h-[68vh] overflow-y-auto scroll-thin">
            {board.isLoading && <Spinner />}
            {board.error && <div className="p-3"><ErrorBox error={board.error} /></div>}
            {board.data && view === 'doctors' && doctors.length === 0 && (
              <Empty icon="CalendarX" title={q ? 'No doctor matches' : `No OPD on ${board.data.weekday}`}>{q ? 'Try another name.' : 'No doctor has a session scheduled for this date.'}</Empty>
            )}
            {view === 'doctors' && doctors.map((d) => {
              const pct = d.capacity ? Math.min(100, Math.round((d.active / d.capacity) * 100)) : 0
              return (
                <button key={d.doctor_id} onClick={() => setParam('doctor', d.doctor_id)}
                  className={cn('block w-full border-b border-line px-3 py-2 text-left last:border-0 hover:bg-surface-2',
                    d.doctor_id === doctorId && 'bg-brand-50 ring-1 ring-inset ring-brand-600/30 dark:bg-brand-500/10')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">{d.name}</span>
                    {d.on_leave ? <Badge tone="red">On leave</Badge> : <span className="tabular text-xs text-ink-2">{d.active}/{d.capacity || '—'}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3">{[d.department, d.room, d.sessions.join(', ')].filter(Boolean).join(' · ')}</div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line" aria-label={`${pct}% booked`}>
                    <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
                  </div>
                  {(d.counts['Checked-in'] || d.counts['In Consultation']) ? (
                    <div className="mt-1 flex gap-1 text-[11px] text-ink-2">
                      {d.counts['Checked-in'] ? <span>{d.counts['Checked-in']} waiting</span> : null}
                      {d.counts['In Consultation'] ? <span>· {d.counts['In Consultation']} in consult</span> : null}
                    </div>
                  ) : null}
                </button>
              )
            })}
            {view === 'units' && (board.data?.units ?? []).map((u) => (
              <button key={u.department_id ?? '-'} onClick={() => { setDept(u.department_id ?? ''); setView('doctors') }}
                className="block w-full border-b border-line px-3 py-2 text-left last:border-0 hover:bg-surface-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{u.name}</span>
                  <span className="tabular text-xs text-ink-2">{u.total}/{u.capacity}</span>
                </div>
                <div className="text-xs text-ink-3">{u.doctors} doctor{u.doctors === 1 ? '' : 's'} · {u.by_status['Booked'] ?? 0} booked · {u.by_status['Checked-in'] ?? 0} waiting · {u.by_status['Completed'] ?? 0} seen</div>
              </button>
            ))}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          {!doctor ? (
            !board.isLoading && <Card><Empty icon="Stethoscope" title="Choose a doctor">Select a doctor on the left to see the slot grid.</Empty></Card>
          ) : (
            <>
              {/* slot grid */}
              <Card icon="CalendarClock"
                title={<span>{doctor.name} <span className="font-normal text-ink-2">· {doctor.department ?? 'OPD'}{grid.data?.room ? ` · ${grid.data.room}` : ''}</span></span>}
                actions={grid.data && (
                  <span className="text-xs text-ink-2">
                    {grid.data.sessions.map((s) => `${s.start}–${s.end}`).join(', ') || 'No session'} · {grid.data.booked}/{grid.data.capacity} booked
                    {grid.data.consult_fee ? ` · ${money(grid.data.consult_fee, true)}` : ''}
                  </span>
                )}>
                {grid.isLoading && <Spinner />}
                {grid.error && <ErrorBox error={grid.error} />}
                {grid.data?.on_leave && (
                  <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                    Unavailable {grid.data.on_leave.from_date} to {grid.data.on_leave.to_date}{grid.data.on_leave.reason ? ` — ${grid.data.on_leave.reason}` : ''}. Existing bookings below need rescheduling.
                  </div>
                )}
                {grid.data && grid.data.slots.length === 0 && (
                  <Empty icon="CalendarX" title={grid.data.has_schedule ? `No session on ${grid.data.weekday}` : 'No schedule configured'}>
                    {grid.data.has_schedule ? 'Pick another date.' : 'Add a Doctor Schedule to generate slots, or book an extra (overbook) below.'}
                  </Empty>
                )}
                {grid.data && grid.data.slots.length > 0 && (
                  <>
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 md:grid-cols-6 xl:grid-cols-8" role="grid" aria-label="Appointment slots">
                      {grid.data.slots.map((s) => {
                        const a = s.appointments[0]
                        const isSel = (s.status === 'free' && slot === s.time && !extra.on) || (a && selected?.id === a.id)
                        const clickable = s.status === 'free' || s.status === 'booked'
                        return (
                          <button key={s.time + (s.off_grid ? 'x' : '')} disabled={!clickable || (s.status === 'booked' && !a)}
                            onClick={() => {
                              if (s.status === 'free') { setSlot(s.time); setExtra({ on: false, time: '' }); setSelected(null) }
                              else if (a) { setSelected(a); setSlot(null) }
                            }}
                            title={a ? `${a.patient ?? ''} · ${a.uhid ?? ''} · ${a.status}` : `${s.time} · ${SLOT_LABEL[s.status]}`}
                            className={cn('flex min-h-14 flex-col items-start rounded-lg border px-2 py-1.5 text-left transition-colors disabled:cursor-default',
                              SLOT_STYLE[s.status], isSel && 'ring-2 ring-brand-600 ring-offset-1 ring-offset-surface')}>
                            <span className="tabular text-sm font-semibold">{s.time}{s.off_grid && <span className="ml-1 text-[10px] font-normal">extra</span>}</span>
                            {a ? (
                              <span className="w-full truncate text-[11px]">#{a.token_no} {shortName(a.patient)}{s.appointments.length > 1 ? ` +${s.appointments.length - 1}` : ''}</span>
                            ) : <span className="text-[11px]">{SLOT_LABEL[s.status]}</span>}
                            {a && <span className="text-[10px] opacity-80">{a.status}</span>}
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-3">
                      {(Object.keys(SLOT_LABEL) as SlotStatus[]).map((k) => (
                        <span key={k} className="inline-flex items-center gap-1"><span className={cn('size-3 rounded border', SLOT_STYLE[k])} />{SLOT_LABEL[k]}</span>
                      ))}
                      <span className="ml-auto">{freeCount} free</span>
                    </div>
                  </>
                )}
              </Card>

              {/* booking / reschedule panel */}
              {canWrite && (
                <Card icon={rescheduling ? 'CalendarSync' : 'CalendarPlus'} title={rescheduling ? `Move ${rescheduling.code}` : 'New booking'}
                  actions={!rescheduling && <Link to="/m/registration/patient-registration" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-300"><UserPlus className="size-4" /> Register new patient</Link>}>
                  <form className="grid gap-3 md:grid-cols-6" onSubmit={(e) => { e.preventDefault(); if (rescheduling) move.mutate(); else book.mutate() }}>
                    {!rescheduling && (
                      <>
                        <FieldWrap label="Patient (UHID, name or mobile)" required className="md:col-span-3">
                          <RefPicker refName="registration.patients" kind="patient" value={patientId} filter={{ status: 'Active' }}
                            onChange={(id) => { setPatientId(id); setParam('patient', id) }} placeholder="Search UHID / name / mobile" />
                        </FieldWrap>
                        <FieldWrap label="Visit type" className="md:col-span-1">
                          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
                        </FieldWrap>
                        <FieldWrap label="Source" className="md:col-span-2">
                          <Select value={form.booking_source} onChange={(e) => setForm({ ...form, booking_source: e.target.value })}>{SOURCES.map((t) => <option key={t}>{t}</option>)}</Select>
                        </FieldWrap>
                        <FieldWrap label="Reason for visit" className="md:col-span-4">
                          <Input value={form.reason} maxLength={300} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Fever for 3 days" />
                        </FieldWrap>
                      </>
                    )}
                    <FieldWrap label="Slot" className={rescheduling ? 'md:col-span-4' : 'md:col-span-2'}>
                      <div className="flex h-9 items-center gap-2 text-sm">
                        {slotOrExtra ? <span className="font-medium text-ink">{dayLabel} · {slotOrExtra} · {doctor.name}</span> : <span className="text-ink-3">Click a free slot above</span>}
                      </div>
                    </FieldWrap>
                    {canOverbook && (
                      <div className="flex items-end gap-2 md:col-span-2">
                        <label className="inline-flex h-9 items-center gap-2 text-sm text-ink-2">
                          <input type="checkbox" className="size-4 accent-brand-700" checked={extra.on}
                            onChange={(e) => { setExtra({ on: e.target.checked, time: extra.time || format(new Date(), 'HH:mm') }); setSlot(null) }} />
                          Extra (overbook)
                        </label>
                        {extra.on && <Input type="time" className="h-9 w-28" value={extra.time} onChange={(e) => setExtra({ ...extra, time: e.target.value })} aria-label="Extra slot time" />}
                      </div>
                    )}
                    <div className="flex items-end justify-end gap-2 md:col-span-6">
                      {!rescheduling && slot && <Button type="button" variant="ghost" onClick={() => setSlot(null)}>Clear</Button>}
                      <Button type="submit" variant="primary" icon={rescheduling ? 'CalendarSync' : 'CalendarCheck'}
                        disabled={!slotOrExtra || (!rescheduling && !patientId)} loading={book.isPending || move.isPending}>
                        {rescheduling ? `Move to ${slotOrExtra ?? '…'}` : slotOrExtra ? `Book ${slotOrExtra}` : 'Book'}
                      </Button>
                    </div>
                  </form>
                </Card>
              )}

              {/* day list */}
              <Card pad={false} icon="ListOrdered" title={`Day list — ${doctor.name}`}
                actions={doctor.queue && <Link to="/m/queue/queue-console" className="text-xs text-brand-700 hover:underline dark:text-brand-300">Queue {doctor.queue}</Link>}>
                {appts.length === 0 ? <Empty icon="CalendarDays" title="No appointments yet" /> : (
                  <div className="overflow-x-auto scroll-thin">
                    <table className="w-full text-sm">
                      <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                        <tr>{['Token', 'Slot', 'Patient', 'Type', 'Source', 'Status', ''].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {appts.map((a) => {
                          const busy = quick.isPending && quick.variables?.a.id === a.id
                          return (
                            <tr key={a.id} onClick={() => setSelected(a)}
                              className={cn('cursor-pointer border-b border-line last:border-0 hover:bg-surface-2', selected?.id === a.id && 'bg-brand-50 dark:bg-brand-500/10',
                                INACTIVE.includes(a.status) && 'text-ink-3')}>
                              <td className="tabular px-3 py-2 font-semibold">{a.token_no ?? '—'}</td>
                              <td className="tabular px-3 py-2">{a.slot}{a.overbooked && <Badge tone="amber" className="ml-1">extra</Badge>}</td>
                              <td className="px-3 py-2">
                                {a.patient_id ? <Link onClick={(e) => e.stopPropagation()} to={`/patients/${a.patient_id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{a.patient}</Link> : '—'}
                                <div className="text-xs text-ink-3">{[a.uhid, [a.age != null ? `${a.age}y` : null, a.gender?.[0]].filter(Boolean).join('/')].filter(Boolean).join(' · ')}{a.rescheduled_from ? ' · rescheduled' : ''}</div>
                              </td>
                              <td className="px-3 py-2 text-ink-2">{a.type}</td>
                              <td className="px-3 py-2 text-ink-2">{a.booking_source}</td>
                              <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                              <td className="whitespace-nowrap px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                {canWrite && a.status === 'Booked' && (
                                  <div className="flex justify-end gap-1">
                                    {date === today && <Button size="xs" variant="success" loading={busy} onClick={() => quick.mutate({ a, to: 'Checked-in' })}>Check in</Button>}
                                    <Button size="xs" variant="secondary" onClick={() => startReschedule(a)}>Reschedule</Button>
                                    <Button size="xs" variant="ghost" className="text-red-600" onClick={() => openCancel(a)}>Cancel</Button>
                                    {date <= today && <Button size="xs" variant="ghost" onClick={() => { if (confirm(`Mark ${a.code} (${a.patient}) as no-show?`)) quick.mutate({ a, to: 'No-show' }) }}>No-show</Button>}
                                  </div>
                                )}
                                {canWrite && a.status === 'Checked-in' && (
                                  <Button size="xs" variant="ghost" className="text-red-600" onClick={() => openCancel(a)}>Cancel</Button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
      {tr && apptEnt && (
        <TransitionDialog entity={apptEnt} rec={tr.rec} t={tr.t} onClose={() => setTr(null)} onDone={() => { setTr(null); refresh() }} />
      )}
    </div>
  )
}
