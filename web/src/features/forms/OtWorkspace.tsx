/** OT module page: pick an OT booking (today and upcoming) or a patient, then work the 21-sheet booklet. */
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { RefPicker } from '@/components/fields'
import { Card, cn, Empty, FieldWrap, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, todayISO } from '@/lib/format'
import type { Rec } from '@/lib/types'
import { OtBooklet } from './OtBooklet'

export default function OtWorkspace() {
  const [sp, setSp] = useSearchParams()
  const booking = sp.get('booking') ?? ''
  const patient = sp.get('patient') ?? ''
  const encounter = sp.get('encounter') ?? ''
  const list = useQuery({
    queryKey: ['m', 'ot', 'bookings', 'booklet-picker'],
    queryFn: () => api<{ rows: Rec[]; refs: Record<string, string> }>('/m/ot/bookings', { query: { date_from: todayISO(), limit: 50, sort: 'scheduled_at' } }),
  })
  const pick = (b: Rec) => setSp(new URLSearchParams(Object.entries({ booking: b.id, patient: b.patient_id ?? '', encounter: b.encounter_id ?? '' }).filter(([, v]) => v)), { replace: true })
  const refs = list.data?.refs ?? {}
  return (
    <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="space-y-3">
        <Card title="Today & upcoming" icon="CalendarClock" pad={false}>
          {list.isLoading ? <Spinner /> : !(list.data?.rows.length) ? <Empty icon="Scissors" title="No OT bookings from today" /> : (
            <ul className="divide-y divide-line">
              {list.data!.rows.filter((b) => b.status !== 'Cancelled').map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => pick(b)} className={cn('w-full px-3 py-2 text-left hover:bg-surface-2', b.id === booking && 'bg-brand-50 dark:bg-brand-500/10')}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-ink">{refs[b.patient_id ?? ''] ?? '—'}</span><StatusBadge status={b.status} /></div>
                    <div className="truncate text-xs text-ink-2">{b.procedure}</div>
                    <div className="text-xs text-ink-3">{dateTime(b.scheduled_at)} · {refs[b.theatre] ?? ''}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Or open by patient" icon="User">
          <FieldWrap label="Patient" help="Sheets are saved against the admission when there is no booking.">
            <RefPicker refName="registration.patients" kind="patient" value={patient || null} onChange={(id) => setSp(id ? new URLSearchParams({ patient: id }) : new URLSearchParams(), { replace: true })} />
          </FieldWrap>
        </Card>
      </div>
      <div className="min-w-0">
        {patient ? <OtBooklet key={`${patient}:${booking}`} patientId={patient} encounterId={encounter || undefined} bookingId={booking || undefined} />
          : <Card><Empty icon="BookOpen" title="Pick an OT booking or a patient">The booklet has 21 sheets across pre-op, intra-op and post-op.</Empty></Card>}
      </div>
    </div>
  )
}
