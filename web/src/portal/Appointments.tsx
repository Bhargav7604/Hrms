import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format } from 'date-fns'
import { CalendarPlus, CheckCircle2, ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Select, Spinner } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { money } from '@/lib/format'
import { ApptCard, Section } from './Home'
import { papi, usePortal, type Appt } from './lib'

interface Doctor { id: string; name: string; specialization?: string | null; department_id?: string | null; department?: string | null; sessions: string[]; mode?: string | null; consult_fee?: number | null; on_leave: boolean }
interface Slots { date: string; doctor: { id: string; name: string; department?: string | null }; on_leave: boolean; consult_fee?: number | null; room?: string | null; sessions: { start: string; end: string }[]; slots: { time: string; status: 'free' | 'taken' | 'past' | 'full' | 'leave' }[] }

export function Appointments() {
  const { pid } = usePortal()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming')
  const [cancel, setCancel] = useState<Appt | null>(null)
  const [reason, setReason] = useState('')
  const q = useQuery({ queryKey: ['portal', pid, 'appointments'], queryFn: () => papi<{ upcoming: Appt[]; past: Appt[] }>('/appointments', { query: { pid } }) })
  const doCancel = useMutation({
    mutationFn: (a: Appt) => papi<Appt>(`/appointments/${a.id}/cancel`, { method: 'POST', body: { reason: reason || undefined }, query: { pid } }),
    onSuccess: (a) => { toast.success(`Appointment ${a.code} cancelled`); setCancel(null); setReason(''); qc.invalidateQueries({ queryKey: ['portal', pid] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = q.data?.[tab] ?? []
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-ink">Appointments</h1>
        <Link to="/portal/appointments/book" className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-800"><CalendarPlus className="size-4" /> Book</Link>
      </div>
      <Segmented value={tab} onChange={setTab} options={[{ key: 'upcoming', label: `Upcoming (${q.data?.upcoming.length ?? 0})` }, { key: 'past', label: 'Past & cancelled' }]} />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <Section title={tab === 'upcoming' ? 'Upcoming' : 'History'}>
          {rows.length === 0 ? <Empty icon="CalendarDays" title={tab === 'upcoming' ? 'No upcoming appointments' : 'No past visits'} /> : (
            <div className="divide-y divide-line">
              {rows.map((a) => (
                <ApptCard key={a.id} a={a}>
                  {a.reason && <div className="mt-0.5 truncate text-xs text-ink-2">{a.reason}</div>}
                  {a.can_cancel && <Button size="xs" variant="ghost" className="mt-1 -ml-2 text-red-600" onClick={() => setCancel(a)}>Cancel appointment</Button>}
                </ApptCard>
              ))}
            </div>
          )}
        </Section>
      )}
      <p className="text-xs text-ink-3">Please arrive 15 minutes early with your UHID card. To change a booking, cancel it and book a new slot, or call the hospital.</p>
      {cancel && (
        <Modal open onClose={() => setCancel(null)} title="Cancel appointment?" size="sm"
          footer={<><Button variant="ghost" onClick={() => setCancel(null)}>Keep it</Button><Button variant="danger" loading={doCancel.isPending} onClick={() => doCancel.mutate(cancel)}>Cancel appointment</Button></>}>
          <p className="text-sm text-ink-2">{cancel.doctor} · {format(new Date(`${cancel.date}T00:00:00`), 'EEE dd MMM')} at {cancel.slot}</p>
          <FieldWrap label="Reason (optional)" className="mt-3"><Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Feeling better" /></FieldWrap>
        </Modal>
      )}
    </div>
  )
}

export function BookAppointment() {
  const { pid, profile } = usePortal()
  const qc = useQueryClient()
  const nav = useNavigate()
  const days = Array.from({ length: 14 }, (_, i) => addDays(new Date(), i))
  const [dept, setDept] = useState('')
  const [day, setDay] = useState(format(days[0], 'yyyy-MM-dd'))
  const [doctor, setDoctor] = useState<Doctor | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [type, setType] = useState('New')
  const [reason, setReason] = useState('')
  const [booked, setBooked] = useState<Appt | null>(null)

  const departments = useQuery({ queryKey: ['portal', 'departments'], queryFn: () => papi<{ id: string; name: string }[]>('/departments'), staleTime: 10 * 60_000 })
  const doctors = useQuery({
    queryKey: ['portal', 'doctors', day, dept],
    queryFn: () => papi<Doctor[]>('/doctors', { query: { date: day, department_id: dept || undefined } }),
  })
  const slots = useQuery({
    queryKey: ['portal', 'slots', doctor?.id, day],
    queryFn: () => papi<Slots>('/slots', { query: { doctor_id: doctor!.id, date: day } }),
    enabled: !!doctor,
  })
  const book = useMutation({
    mutationFn: () => papi<Appt>('/appointments', { method: 'POST', query: { pid }, body: { doctor_id: doctor!.id, date: day, slot, type, reason: reason || undefined } }),
    onSuccess: (a) => { setBooked(a); qc.invalidateQueries({ queryKey: ['portal', pid] }); qc.invalidateQueries({ queryKey: ['portal', 'slots'] }) },
    onError: (e) => { toast.error(errorMessage(e)); slots.refetch() },
  })

  if (booked) {
    return (
      <div className="space-y-4 rounded-2xl border border-line bg-surface p-6 text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <h1 className="text-xl font-semibold text-ink">Appointment booked</h1>
        <div className="text-sm text-ink-2">{booked.doctor} · {booked.department}</div>
        <div className="text-lg font-semibold text-ink">{format(new Date(`${booked.date}T00:00:00`), 'EEEE, dd MMMM')} at {booked.slot}</div>
        <div className="tabular text-sm text-ink-2">Token {booked.token_no} · {booked.code}</div>
        {booked.type === 'Teleconsult' && <p className="text-sm text-violet-700 dark:text-violet-300">This is a video consultation. Join from "Video consult" 30 minutes before your slot.</p>}
        <p className="text-xs text-ink-3">We have sent a confirmation by SMS. Please check in at the reception 15 minutes before your time.</p>
        <div className="flex justify-center gap-2">
          <Button onClick={() => nav('/portal/appointments')}>My appointments</Button>
          <Button variant="primary" onClick={() => { setBooked(null); setSlot(null); setReason('') }}>Book another</Button>
        </div>
      </div>
    )
  }

  const free = slots.data?.slots.filter((s) => s.status === 'free').length ?? 0
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/portal/appointments" className="rounded-full p-1.5 text-ink-2 hover:bg-surface-2" aria-label="Back"><ChevronLeft className="size-5" /></Link>
        <h1 className="text-xl font-semibold text-ink">Book a visit{profile.self ? '' : ` for ${profile.name}`}</h1>
      </div>

      <FieldWrap label="Department">
        <Select className="h-11" value={dept} onChange={(e) => { setDept(e.target.value); setDoctor(null); setSlot(null) }}>
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </FieldWrap>

      <div>
        <div className="mb-1 text-xs font-medium text-ink-2">Date</div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scroll-thin" role="listbox" aria-label="Date">
          {days.map((d) => {
            const v = format(d, 'yyyy-MM-dd')
            const on = v === day
            return (
              <button key={v} role="option" aria-selected={on} onClick={() => { setDay(v); setSlot(null) }}
                className={cn('flex w-14 shrink-0 flex-col items-center rounded-xl border py-1.5', on ? 'border-brand-700 bg-brand-700 text-white' : 'border-line-2 bg-surface text-ink')}>
                <span className="text-[11px]">{format(d, 'EEE')}</span>
                <span className="tabular text-lg font-bold leading-tight">{format(d, 'd')}</span>
                <span className="text-[11px]">{format(d, 'MMM')}</span>
              </button>
            )
          })}
        </div>
      </div>

      <Section title="Choose a doctor">
        {doctors.isLoading && <Spinner />}
        {doctors.error && <div className="p-3"><ErrorBox error={doctors.error} /></div>}
        {doctors.data?.length === 0 && <Empty icon="CalendarX" title="No OPD on this day">Try another date or department.</Empty>}
        <ul className="max-h-80 divide-y divide-line overflow-y-auto scroll-thin">
          {doctors.data?.map((d) => (
            <li key={d.id}>
              <button disabled={d.on_leave} onClick={() => { setDoctor(d); setSlot(null) }}
                className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left disabled:opacity-50', doctor?.id === d.id ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.name}</span>
                  <span className="block truncate text-xs text-ink-3">{[d.specialization, d.department, d.sessions.join(', ')].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-ink-2">{d.on_leave ? 'On leave' : d.consult_fee ? money(d.consult_fee, true) : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {doctor && (
        <Section title={`Time — ${doctor.name}`} action={slots.data && <span className="text-xs text-ink-3">{free} free</span>}>
          <div className="p-4">
            {slots.isLoading && <Spinner />}
            {slots.error && <ErrorBox error={slots.error} />}
            {slots.data?.on_leave && <p className="text-sm text-red-700 dark:text-red-300">The doctor is not available on this day.</p>}
            {slots.data && !slots.data.on_leave && slots.data.slots.length === 0 && <p className="text-sm text-ink-2">No session on this day.</p>}
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {slots.data?.slots.map((s) => (
                <button key={s.time} disabled={s.status !== 'free'} onClick={() => setSlot(s.time)} aria-pressed={slot === s.time}
                  aria-label={`${s.time} ${s.status === 'free' ? 'available' : s.status}`}
                  className={cn('tabular h-11 rounded-lg border text-sm font-medium',
                    s.status !== 'free' ? 'border-line bg-surface-2 text-ink-3 line-through' : slot === s.time ? 'border-brand-700 bg-brand-700 text-white' : 'border-line-2 bg-surface text-ink hover:border-brand-600')}>
                  {s.time}
                </button>
              ))}
            </div>
            {slots.data && slots.data.slots.length > 0 && <p className="mt-2 text-xs text-ink-3">Crossed-out times are taken or past.</p>}
          </div>
        </Section>
      )}

      {doctor && slot && (
        <Section title="Confirm">
          <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); book.mutate() }}>
            <div className="text-sm text-ink">{doctor.name} · {format(new Date(`${day}T00:00:00`), 'EEE dd MMM')} at <b>{slot}</b>{slots.data?.consult_fee ? ` · fee ${money(slots.data.consult_fee, true)} (pay at the hospital)` : ''}</div>
            <FieldWrap label="Type of visit">
              <Select className="h-11" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="New">New consultation</option>
                <option value="Follow-up">Follow-up</option>
                <option value="Review with reports">Review with reports</option>
                {doctor.mode !== 'In-person' && <option value="Teleconsult">Video consultation</option>}
              </Select>
            </FieldWrap>
            <FieldWrap label="Reason for visit (optional)">
              <Input className="h-11" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. fever and cough for 3 days" />
            </FieldWrap>
            <Button type="submit" variant="primary" className="h-11 w-full text-base" loading={book.isPending}>Book appointment</Button>
          </form>
        </Section>
      )}
    </div>
  )
}
