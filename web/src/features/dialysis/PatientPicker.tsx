import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useDebounced } from '@/components/fields'
import { Avatar, Badge, cn, Empty, ErrorBox, Input, Kbd, Modal, Spinner } from '@/components/ui'
import { get } from '@/lib/api'
import { date } from '@/lib/format'
import { DK, SESSION_TONE, type DeskList, type DeskRow } from './api'

/** "Select patient": only patients billed for a dialysis service (OP bill line or IP number) can be picked. */
export default function PatientPicker({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 250)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const list = useQuery({
    queryKey: DK.patients(dq),
    queryFn: () => get<DeskList>('/dialysis/desk/patients', { q: dq || undefined }),
    placeholderData: (p) => p,
  })
  const rows = list.data?.rows ?? []
  const pickable = rows.filter((r) => r.eligible)
  useEffect(() => { setCursor(0) }, [dq])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(pickable.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
    else if (e.key === 'Enter' && pickable[cursor]) { e.preventDefault(); onPick(pickable[cursor].id) }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Select patient">
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" aria-hidden />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} className="pl-8"
            placeholder="Search by UHID / patient / bill no / IP no…" aria-label="Search dialysis patients" />
        </div>
        <div className="flex items-center justify-between text-xs text-ink-2">
          <span className="tabular">{list.data ? `${list.data.total} dialysis patient(s) billed · showing ${list.data.showing}` : ' '}</span>
          <span className="hidden sm:inline"><Kbd>↑</Kbd> <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open</span>
        </div>
        {list.isLoading ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? (
          <Empty icon="Droplets" title={dq ? `No billed dialysis patient matches “${dq}”` : 'No patient has been billed for a dialysis service.'}>
            Bill a dialysis session at the OP billing counter, or admit the patient with an active dialysis prescription.
          </Empty>
        ) : (
          <ul ref={listRef} className="divide-y divide-line rounded-lg border border-line" role="listbox" aria-label="Dialysis patients">
            {rows.map((r) => {
              const idx = pickable.indexOf(r)
              return <PickRow key={r.id} r={r} idx={idx} active={idx >= 0 && idx === cursor} onPick={() => onPick(r.id)} onHover={() => idx >= 0 && setCursor(idx)} />
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

function PickRow({ r, idx, active, onPick, onHover }: { r: DeskRow; idx: number; active: boolean; onPick: () => void; onHover: () => void }) {
  const why = r.eligible ? null
    : r.bills.length ? 'Every billed session has been used — bill another session at the OP counter.'
      : 'Nothing to use — bill a dialysis session first.'
  return (
    <li role="option" aria-selected={active} aria-disabled={!r.eligible} data-idx={idx >= 0 ? idx : undefined}>
      <button type="button" disabled={!r.eligible} onClick={onPick} onMouseEnter={onHover}
        className={cn('flex w-full items-start gap-3 px-3 py-2.5 text-left', r.eligible ? 'hover:bg-surface-2' : 'cursor-not-allowed opacity-60',
          active && 'bg-brand-50 dark:bg-brand-500/10')}>
        <Avatar name={r.name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-ink">{r.name ?? 'Patient'}</span>
            <span className="text-xs text-ink-3">{[r.uhid, r.age !== null && r.age !== undefined ? `${r.age}y` : null, r.gender].filter(Boolean).join(' · ')}</span>
          </span>
          {r.bills.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {r.bills.map((b) => (
                <Badge key={b.charge_id} tone={b.available ? 'green' : 'gray'}>
                  Bill {b.bill} · {b.available ? `${b.available} of ${b.sessions} unused` : 'used'}{b.billed_at ? ` · ${date(b.billed_at)}` : ''}
                </Badge>
              ))}
            </span>
          )}
          {r.ip && <span className="mt-1 block text-xs text-ink-2">IP {r.ip.ip_no}{r.ip.ward ? ` · ${r.ip.ward}` : ''}{r.ip.bed ? ` / ${r.ip.bed}` : ''} — billed per session on the IP account</span>}
          {why && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{why}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {r.open_session && <Badge tone={SESSION_TONE[r.open_session.status] ?? 'gray'} dot>{r.open_session.code} · {r.open_session.status}</Badge>}
          {r.available_sessions > 0 && <Badge tone="green">{r.available_sessions} unused</Badge>}
          {r.ip && <Badge tone="blue">Admitted</Badge>}
        </span>
      </button>
    </li>
  )
}
