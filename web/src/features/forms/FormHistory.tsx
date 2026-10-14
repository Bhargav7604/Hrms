/** Recent clinical form entries and latest scores for a patient / admission (chart widgets, timelines). */
import { useQuery } from '@tanstack/react-query'
import { AlarmClock } from 'lucide-react'
import { useState } from 'react'
import { Badge, cn, Drawer, ErrorBox, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { ago, dateTime } from '@/lib/format'
import { fk, useEntries } from './api'
import { FormRunner } from './FormRunner'
import { badgeTone } from './logic'
import type { Band, EntryRow, FormContext } from './types'

export interface ScoreRow extends EntryRow { band?: Band | null; lower_is_worse?: boolean; score_max?: number | null }

export function useLatestScores(patientId: string, encounterId?: string) {
  return useQuery({
    queryKey: fk.scores(patientId, encounterId),
    queryFn: () => api<{ rows: ScoreRow[] }>('/forms/scores', { query: { patient_id: patientId, encounter_id: encounterId } }),
    enabled: !!patientId,
  })
}

/** Chips with the latest signed score of each scored instrument (Morse, Braden, MEWS, GCS …). */
export function LatestScores({ patientId, encounterId, onOpen }: FormContext & { onOpen?: (row: ScoreRow) => void }) {
  const q = useLatestScores(patientId, encounterId)
  if (q.isLoading || !q.data?.rows.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {q.data.rows.map((r) => (
        <button key={r.form_key} type="button" onClick={() => onOpen?.(r)} title={`${r.form_title} · ${dateTime(r.noted_at)}${r.band?.action ? `\n${r.band.action}` : ''}`}
          className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs', r.overdue ? 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10' : 'border-line bg-surface hover:bg-surface-2')}>
          <span className="font-medium text-ink">{r.short ?? r.form_title}</span>
          <Badge tone={badgeTone(r.risk_tone)}>{r.score}{r.risk_band ? ` · ${r.risk_band}` : ''}</Badge>
          {r.overdue && <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300"><AlarmClock className="size-3" /> due</span>}
        </button>
      ))}
    </div>
  )
}

export function FormHistory({ patientId, encounterId, suite, limit = 8, title, showScores = true, onOpen }: FormContext & {
  suite?: string; limit?: number; title?: string; showScores?: boolean; onOpen?: (entry: EntryRow) => void
}) {
  const q = useEntries({ patient_id: patientId, encounter_id: encounterId, suite, limit })
  const [open, setOpen] = useState<EntryRow | null>(null)
  const pick = (r: EntryRow) => (onOpen ? onOpen(r) : setOpen(r))
  if (q.isLoading) return <Spinner label="Loading forms…" />
  if (q.error) return <ErrorBox error={q.error} />
  const rows = q.data?.rows ?? []
  return (
    <div className="space-y-2">
      {title && <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</div>}
      {showScores && <LatestScores patientId={patientId} encounterId={encounterId}
        onOpen={(r) => pick(r)} />}
      {!rows.length ? (
        <p className="py-3 text-center text-xs text-ink-3">No clinical forms recorded{encounterId ? ' for this admission' : ''} yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => pick(r)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left hover:bg-surface-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.form_title}</span>
                {r.score !== null && r.score !== undefined && <Badge tone={badgeTone(r.risk_tone)}>{r.score_label} {r.score}{r.risk_band ? ` · ${r.risk_band}` : ''}</Badge>}
                <StatusBadge status={r.status} />
                <span className="w-full truncate text-xs text-ink-3">{dateTime(r.noted_at)} · {r.signed_by_name ?? r.author_name ?? '—'}{r.summary && !r.score_label ? ` · ${r.summary}` : ''}
                  {r.overdue && ` · reassessment due ${ago(r.next_due_at)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={open.form_title} subtitle={`${open.code ?? ''} · ${dateTime(open.noted_at)}`} width="max-w-4xl">
          <div className="p-4">
            <FormRunner formKey={open.form_key} recordId={open.id} patientId={patientId} encounterId={encounterId ?? open.encounter_id ?? undefined}
              hideHistory onClose={() => setOpen(null)} />
          </div>
        </Drawer>
      )}
    </div>
  )
}
