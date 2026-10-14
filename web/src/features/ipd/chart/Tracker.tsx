import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, cn, Drawer, ErrorBox, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K, ROLE_LABEL, useSettlement, useTracker, type ClearanceRow, type Tracker, type TrackerStep } from '../api'
import { ReasonDialog } from '../ui'

const STEP_ICON: Record<string, string> = { admitted: 'BedDouble', initiated: 'LogOut', clearances: 'ClipboardCheck', settlement: 'IndianRupee', discharged: 'DoorOpen' }

/** Discharge tracker drawer: five steps, departmental clearances and roles notified per step. */
export function DischargeTrackerDrawer({ admissionId, open, onClose, onInitiate, money: canMoney }: {
  admissionId: string; open: boolean; onClose: () => void; onInitiate?: () => void; money?: boolean
}) {
  const t = useTracker(admissionId, open)
  const settle = useSettlement(admissionId, open && !!canMoney)
  const [configure, setConfigure] = useState(false)
  const [revoke, setRevoke] = useState(false)
  const qc = useQueryClient()
  const refresh = () => { qc.invalidateQueries({ queryKey: K.tracker(admissionId) }); qc.invalidateQueries({ queryKey: K.chart(admissionId) }); qc.invalidateQueries({ queryKey: ['x', 'discharge'] }) }
  const doRevoke = useMutation({
    mutationFn: (reason: string) => api(`/ipchart/admissions/${admissionId}/revoke-discharge`, { method: 'POST', body: { reason } }),
    onSuccess: () => { toast.success('Discharge revoked — patient stays admitted'); setRevoke(false); refresh(); qc.invalidateQueries({ queryKey: ['x', 'ipd'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const d = t.data
  const state = !d ? '' : d.admission.status === 'Discharged' ? 'Completed' : d.admission.status === 'Discharge Initiated' ? 'In progress' : 'Not started'
  return (
    <Drawer open={open} onClose={onClose} width="max-w-lg" title="Discharge tracker" subtitle={d ? `${d.admission.code} · ${d.admission.status}` : undefined}
      footer={d && <>
        {d.can_revoke && <Button variant="ghost" size="sm" className="mr-auto text-red-600" onClick={() => setRevoke(true)}>Revoke discharge</Button>}
        {d.can_initiate && onInitiate && <Button variant="primary" size="sm" icon="LogOut" onClick={onInitiate}>Initiate discharge</Button>}
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </>}>
      {t.isLoading ? <Spinner /> : t.error ? <div className="p-5"><ErrorBox error={t.error} /></div> : d && (
        <div className="space-y-4 p-5">
          <div className="rounded-xl border border-line bg-surface-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Discharge progress</div>
                <div className="text-lg font-semibold text-ink">{d.done} <span className="text-sm font-normal text-ink-2">of {d.total} steps</span></div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={state === 'Completed' ? 'green' : state === 'In progress' ? 'blue' : 'gray'}>{state}</Badge>
                {d.can_configure && (
                  <button type="button" onClick={() => setConfigure(!configure)} aria-pressed={configure} title="Choose who is notified at each step"
                    className={cn('grid size-7 place-items-center rounded-md ring-1 ring-line-2 hover:bg-surface', configure && 'bg-brand-700 text-white ring-brand-700')}>
                    <Icon name="SlidersHorizontal" className="size-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-indigo-700 transition-all dark:bg-indigo-400" style={{ width: `${(d.done / d.total) * 100}%` }} /></div>
            {d.next && <div className="mt-1.5 text-xs text-ink-2">Next up: <b className="text-ink">{d.next}</b></div>}
          </div>
          <ol className="space-y-1">
            {d.steps.map((s, i) => (
              <Step key={s.key} s={s} last={i === d.steps.length - 1} t={d} admissionId={admissionId} configure={configure} onChanged={refresh}
                settlement={s.key === 'settlement' ? settle.data ?? null : null} money={!!canMoney} />
            ))}
          </ol>
          {d.notifications.length > 0 && (
            <details className="rounded-lg border border-line px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-ink">Notifications sent ({d.notifications.length})</summary>
              <ul className="mt-2 space-y-1.5 text-ink-2">
                {d.notifications.map((n, i) => (
                  <li key={i}><b className="text-ink">{n.step}</b> → {n.roles.length ? n.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') : 'nobody configured'} · {dateTime(n.at)}<div className="text-ink-3">{n.message}</div></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <ReasonDialog open={revoke} title="Revoke discharge" message="The patient stays admitted; departmental clearances already signed are kept." confirm="Revoke"
        busy={doRevoke.isPending} onClose={() => setRevoke(false)} onConfirm={(r) => doRevoke.mutate(r)} />
    </Drawer>
  )
}

function Step({ s, last, t, admissionId, configure, onChanged, settlement, money: canMoney }: {
  s: TrackerStep; last: boolean; t: Tracker; admissionId: string; configure: boolean; onChanged: () => void
  settlement: { settled: boolean; label: string; paid?: number | null; balance?: number | null } | null; money: boolean
}) {
  const [editRoles, setEditRoles] = useState(false)
  const done = s.state === 'done'
  const prog = s.state === 'in_progress'
  return (
    <li className="relative flex gap-3 pb-3">
      {!last && <span className={cn('absolute left-[17px] top-9 h-[calc(100%-2rem)] w-0.5', done ? 'bg-emerald-500' : 'bg-line')} />}
      <span className={cn('z-[1] grid size-9 shrink-0 place-items-center rounded-lg ring-1', done ? 'bg-emerald-600 text-white ring-emerald-600' : prog ? 'bg-indigo-50 text-indigo-700 ring-indigo-300 dark:bg-indigo-500/15 dark:text-indigo-200' : 'bg-surface text-ink-3 ring-line')}>
        <Icon name={done ? 'Check' : STEP_ICON[s.key]} className="size-4" />
      </span>
      <div className={cn('min-w-0 flex-1 rounded-lg px-2 py-1', prog && 'bg-indigo-50/60 dark:bg-indigo-500/5')}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-ink">{s.label}</span>
          <Badge tone={done ? 'green' : prog ? 'blue' : 'gray'}>{done ? 'Done' : prog ? 'In progress' : 'Pending'}</Badge>
        </div>
        <div className="text-xs text-ink-2">{s.at ? dateTime(s.at) : null}{s.at && s.by ? ` · ${s.by}` : ''}{(s.at || s.by) && s.detail ? ' · ' : ''}{s.detail}</div>
        {s.key === 'clearances' && t.clearances.length > 0 && <Clearances rows={t.clearances} onChanged={onChanged} />}
        {s.key === 'settlement' && (
          <div className="mt-1 space-y-1 text-xs">
            {settlement && <div className="flex items-center gap-2"><Badge tone={settlement.settled ? 'green' : 'amber'}>{settlement.label}</Badge>{canMoney && settlement.paid != null && <span className="text-ink-2">Paid {money(settlement.paid)}</span>}{canMoney && settlement.balance != null && settlement.balance > 0 && <span className="text-red-700 dark:text-red-300">Due {money(settlement.balance)}</span>}</div>}
            {canMoney && <Link to={`/ip/billing/discharge?admission=${admissionId}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Open discharge desk / settlement →</Link>}
          </div>
        )}
        <NotifyRoles s={s} t={t} admissionId={admissionId} editing={configure || editRoles} setEditing={setEditRoles} onChanged={onChanged} />
      </div>
    </li>
  )
}

function Clearances({ rows, onChanged }: { rows: ClearanceRow[]; onChanged: () => void }) {
  const [hold, setHold] = useState<ClearanceRow | null>(null)
  const sign = useMutation({
    mutationFn: (c: ClearanceRow) => api(`/ipchart/clearances/${c.id}/clear`, { method: 'POST', body: {} }),
    onSuccess: (_, c) => { toast.success(`${c.department} cleared`); onChanged() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const doHold = useMutation({
    mutationFn: ({ c, reason }: { c: ClearanceRow; reason: string }) => api(`/ipchart/clearances/${c.id}/hold`, { method: 'POST', body: { reason } }),
    onSuccess: () => { toast.success('Put on hold'); setHold(null); onChanged() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="mt-2 space-y-1">
      {rows.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1 text-xs">
          <Badge tone={c.status === 'Cleared' ? 'green' : c.status === 'On Hold' ? 'red' : 'amber'}>
            {c.status === 'Cleared' && <Icon name="Check" className="size-3" />}{c.department.toUpperCase()}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-ink-3" title={c.cleared_by ?? c.hold_reason ?? c.blocker ?? c.roles.join(', ')}>
            {c.status === 'Cleared' ? `${c.cleared_by ?? ''} · ${dateTime(c.cleared_at)}` : c.status === 'On Hold' ? `On hold: ${c.hold_reason}` : c.blocker ?? `Signed by ${c.roles.map((r) => ROLE_LABEL[r] ?? r).join(' / ')}`}
          </span>
          {c.can_sign && <Button size="xs" variant="success" disabled={!!c.blocker} title={c.blocker ?? undefined} loading={sign.isPending && sign.variables?.id === c.id} onClick={() => sign.mutate(c)}>Clear</Button>}
          {c.can_hold && <Button size="xs" variant="ghost" onClick={() => setHold(c)}>Hold</Button>}
        </div>
      ))}
      <ReasonDialog open={!!hold} title={`Put ${hold?.department ?? ''} clearance on hold`} confirm="Put on hold" tone="primary" busy={doHold.isPending}
        onClose={() => setHold(null)} onConfirm={(reason) => hold && doHold.mutate({ c: hold, reason })} />
    </div>
  )
}

function NotifyRoles({ s, t, admissionId, editing, setEditing, onChanged }: { s: TrackerStep; t: Tracker; admissionId: string; editing: boolean; setEditing: (v: boolean) => void; onChanged: () => void }) {
  const save = useMutation({
    mutationFn: (roles: string[]) => api(`/ipchart/admissions/${admissionId}/tracker/notify`, { method: 'PUT', body: { step: s.key, roles } }),
    onSuccess: onChanged,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const roles = s.notify_roles
  if (!editing) {
    return (
      <div className="mt-1 text-[11px] text-ink-3">
        {roles.length ? <>Notifies {roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</> : 'No one is notified'}
        {t.can_configure && <button type="button" className="ml-2 font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setEditing(true)}>+ set roles to notify</button>}
      </div>
    )
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {t.roles.map((r) => {
        const on = roles.includes(r)
        return (
          <button key={r} type="button" aria-pressed={on} disabled={save.isPending} onClick={() => save.mutate(on ? roles.filter((x) => x !== r) : [...roles, r])}
            className={cn('rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset', on ? 'bg-brand-700 text-white ring-brand-700' : 'text-ink-2 ring-line-2 hover:bg-surface-2')}>
            {ROLE_LABEL[r] ?? r}
          </button>
        )
      })}
      <button type="button" className="ml-1 text-[11px] text-ink-3 hover:text-ink" onClick={() => setEditing(false)}>Done</button>
    </div>
  )
}
