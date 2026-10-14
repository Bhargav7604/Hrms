/** Paperless OT booklet: 21 sheets grouped Pre-op · Intra-op · Post-op, with per-sheet status and print. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDashed } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Badge, Button, Card, cn, Empty, ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { fk } from './api'
import { FormRunner } from './FormRunner'
import { badgeTone } from './logic'
import type { Access, EntryRow, FormContext } from './types'

const GROUPS = ['Pre-op', 'Intra-op', 'Post-op'] as const
const GROUP_TINT: Record<string, string> = {
  'Pre-op': 'bg-sky-50/60 dark:bg-sky-500/5', 'Intra-op': 'bg-violet-50/60 dark:bg-violet-500/5', 'Post-op': 'bg-emerald-50/60 dark:bg-emerald-500/5',
}

export interface BookletSheet {
  key: string; title: string; short: string; group: typeof GROUPS[number]; order: number; icon?: string
  status: 'Pending' | 'Draft' | 'Completed'; entry: EntryRow | null; access: Access
}
export interface Booklet {
  bookings: { id: string; code: string; procedure?: string; scheduled_at?: string; status?: string; theatre?: string; surgeon?: string }[]
  booking: Booklet['bookings'][number] | null
  admission: { id: string; code?: string } | null
  sheets: BookletSheet[]
  counts: { total: number; completed: number; draft: number; pending: number }
}

export function useBooklet(patientId: string, encounterId?: string, bookingId?: string) {
  return useQuery({
    queryKey: fk.booklet(patientId, encounterId, bookingId),
    queryFn: () => api<Booklet>('/forms/ot/booklet', { query: { patient_id: patientId, encounter_id: encounterId, booking_id: bookingId } }),
  })
}

function StatusIcon({ s }: { s: BookletSheet['status'] }) {
  if (s === 'Completed') return <CheckCircle2 className="size-4 text-emerald-600" aria-label="Completed" />
  if (s === 'Draft') return <CircleDashed className="size-4 text-amber-500" aria-label="Draft" />
  return <Circle className="size-4 text-ink-3" aria-label="Pending" />
}

export function OtBooklet({ patientId, encounterId, bookingId, onBookTheatre, initialSheet }: FormContext & {
  bookingId?: string; onBookTheatre?: () => void; initialSheet?: string
}) {
  const qc = useQueryClient()
  const [booking, setBooking] = useState<string | undefined>(bookingId)
  useEffect(() => setBooking(bookingId), [bookingId])
  const q = useBooklet(patientId, encounterId, booking)
  const [sheet, setSheet] = useState<string | null>(initialSheet ?? null)
  const [pendingOnly, setPendingOnly] = useState(false)
  // default to the most recent booking for this stay
  useEffect(() => {
    if (!booking && !bookingId && q.data?.bookings.length) setBooking(q.data.bookings[0].id)
  }, [booking, bookingId, q.data])
  const sheets = useMemo(() => (q.data?.sheets ?? []).filter((s) => s.access.view), [q.data])
  if (q.isLoading) return <Spinner label="Opening the OT booklet…" />
  if (q.error) return <ErrorBox error={q.error} />
  const d = q.data!
  if (!sheets.length) return <Empty icon="Lock" title="The OT booklet is not available for your role" />
  const idx = sheet ? sheets.findIndex((s) => s.key === sheet) : -1
  const cur = idx >= 0 ? sheets[idx] : null
  const refresh = () => qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'booklet'] })
  const bIdx = d.bookings.findIndex((b) => b.id === booking)
  const printUrl = `/print/ot-booklet?${new URLSearchParams(Object.entries({ patient: patientId, encounter: encounterId ?? '', booking: booking ?? '' }).filter(([, v]) => v)).toString()}`

  const navigator = (
    <Card pad={false}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            {cur ? `${cur.group} · ${idx + 1} of ${sheets.length}` : 'OT booklet'}
          </div>
          {d.booking ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-ink">{d.booking.procedure}</span>
              <span className="font-mono text-xs text-ink-3">{d.booking.code}</span>
              <span className="text-xs text-ink-2">{dateTime(d.booking.scheduled_at)}{d.booking.theatre ? ` · ${d.booking.theatre}` : ''}{d.booking.surgeon ? ` · ${d.booking.surgeon}` : ''}</span>
              <Badge tone="blue">{d.booking.status}</Badge>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-amber-800 dark:text-amber-200">
              <AlertTriangle className="size-4" /> No OT booking for this stay — sheets are saved against the admission.
              {onBookTheatre ? <button type="button" className="font-medium underline" onClick={onBookTheatre}>Book theatre</button>
                : <Link className="font-medium underline" to="/m/ot/bookings">Book theatre</Link>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {d.bookings.length > 1 && (
            <>
              <Button size="xs" variant="ghost" disabled={bIdx <= 0} onClick={() => setBooking(d.bookings[bIdx - 1]?.id)} aria-label="Previous booking"><ChevronLeft className="size-4" /></Button>
              <span className="text-xs text-ink-3">Booking {bIdx + 1}/{d.bookings.length}</span>
              <Button size="xs" variant="ghost" disabled={bIdx >= d.bookings.length - 1} onClick={() => setBooking(d.bookings[bIdx + 1]?.id)} aria-label="Next booking"><ChevronRight className="size-4" /></Button>
            </>
          )}
          <Button size="xs" variant={cur ? 'secondary' : 'primary'} icon="BookOpen" onClick={() => setSheet(null)}>Booklet</Button>
          <Button size="xs" variant="ghost" disabled={idx <= 0} onClick={() => setSheet(sheets[idx - 1].key)} aria-label="Previous sheet"><ChevronLeft className="size-4" /></Button>
          <Button size="xs" variant="ghost" disabled={idx < 0 ? false : idx >= sheets.length - 1} onClick={() => setSheet(sheets[idx < 0 ? 0 : idx + 1].key)} aria-label="Next sheet"><ChevronRight className="size-4" /></Button>
        </div>
      </div>
      <div className="space-y-1 px-4 py-2.5">
        {GROUPS.map((g) => (
          <div key={g} className="flex flex-wrap items-center gap-1">
            <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g}</span>
            {sheets.filter((s) => s.group === g).map((s) => (
              <button key={s.key} type="button" onClick={() => setSheet(s.key)} aria-current={s.key === sheet}
                className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                  s.key === sheet ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
                <span className={cn('size-1.5 rounded-full', s.status === 'Completed' ? 'bg-emerald-500' : s.status === 'Draft' ? 'bg-amber-500' : s.key === sheet ? 'bg-white/70' : 'bg-line-2')} />
                {s.short}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Card>
  )

  if (cur) {
    return (
      <FormRunner key={`${cur.key}:${booking ?? ''}`} formKey={cur.key} patientId={patientId} encounterId={encounterId} bookingId={booking}
        recordId={cur.entry?.id} header={navigator} hideHistory onSaved={refresh} onSigned={refresh} />
    )
  }
  const pct = d.counts.total ? Math.round((d.counts.completed / d.counts.total) * 100) : 0
  return (
    <div className="space-y-3">
      {navigator}
      <Card pad={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><BookOpen className="size-5" /></div>
            <div>
              <h3 className="text-sm font-semibold text-ink">OT Booklet</h3>
              <p className="text-xs text-ink-2">{d.counts.completed} of {d.counts.total} sheets completed · {d.counts.draft} draft · {d.counts.pending} pending</p>
              <div className="mt-1 h-1.5 w-56 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" className="size-3.5 accent-brand-700" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} /> List pending sheets
            </label>
            <Button size="sm" variant="secondary" icon="Printer" disabled={!d.counts.completed && !d.counts.draft} onClick={() => window.open(printUrl, '_blank')}>Print booklet</Button>
          </div>
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-3">
          {GROUPS.map((g) => {
            const list = sheets.filter((s) => s.group === g && (!pendingOnly || s.status !== 'Completed'))
            return (
              <div key={g} className={cn('rounded-xl border border-line p-2', GROUP_TINT[g])}>
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{g}</div>
                {!list.length && <div className="px-2 py-3 text-xs text-ink-3">All sheets completed</div>}
                {list.map((s) => (
                  <button key={s.key} type="button" onClick={() => setSheet(s.key)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface">
                    <StatusIcon s={s.status} />
                    <span className="min-w-0 flex-1 truncate text-ink">{s.short}</span>
                    {s.entry?.score !== null && s.entry?.score !== undefined && <Badge tone={badgeTone(s.entry.risk_tone)}>{s.entry.score_label} {s.entry.score}</Badge>}
                    <span className={cn('text-xs', s.status === 'Completed' ? 'text-emerald-700 dark:text-emerald-300' : s.status === 'Draft' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-3')}>{s.status}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
