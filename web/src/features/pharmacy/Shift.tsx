import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, Empty, ErrorBox, FieldWrap, Input, Modal, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import { MODE_LABEL, PharmShell, usePharmAccess } from './shell'

interface Coll { mode: string; sales: number; due_collections: number; refunds: number; net: number }
interface ShiftV {
  id: string; code: string; status: string; counter: string; user_name: string; opened_at: string; opening_cash: number; closed_at?: string | null
  expected_cash?: number | null; cash_counted?: number | null; variance?: number | null; remarks?: string | null
  summary: { collections: Coll[]; expected_cash?: number | null; cash_net?: number; total?: number | null; refunds?: number | null; bills?: number | null; sales?: number | null; cancelled?: number; due_bills?: number }
}
interface State { current: ShiftV | null; open_counters: Record<string, string>; counters: string[]; recent: ShiftV[] }
const NOTES = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1]

export default function ShiftSummary() {
  const acc = usePharmAccess()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['x', 'pharmacy', 'shift'], queryFn: () => api<State>('/op-pharmacy/shift'), refetchInterval: 60_000 })
  const [counter, setCounter] = useState('')
  const [float, setFloat] = useState('0')
  const [closing, setClosing] = useState(false)
  const open = useMutation({
    mutationFn: () => api('/op-pharmacy/shift/open', { method: 'POST', body: { counter, opening_cash: Number(float || 0) } }),
    onSuccess: () => { toast.success(`${counter} opened`); qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const s = q.data?.current
  return (
    <PharmShell screen="shift" icon="Clock" title="Shift summary" subtitle="Open the counter with a cash float; close it with a denomination-wise cash count. Collections by payment mode and the cash variance are recorded for the shift.">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="space-y-4">
          {!s && acc.sell && (
            <Card title="Open my shift">
              <div className="flex flex-wrap items-end gap-2">
                <FieldWrap label="Counter" required>
                  <Select value={counter} onChange={(e) => setCounter(e.target.value)} className="w-60"><option value="">Choose…</option>
                    {q.data.counters.map((c) => <option key={c} value={c} disabled={!!q.data.open_counters[c]}>{c}{q.data.open_counters[c] ? ` — open by ${q.data.open_counters[c]}` : ''}</option>)}
                  </Select>
                </FieldWrap>
                <FieldWrap label="Opening cash (float)"><Input type="number" min={0} value={float} onChange={(e) => setFloat(e.target.value)} className="w-36 tabular" /></FieldWrap>
                <Button variant="primary" disabled={!counter} loading={open.isPending} onClick={() => open.mutate()}>Open shift</Button>
              </div>
            </Card>
          )}
          {s && (
            <Card title={<span className="flex items-center gap-2">{s.counter} · {s.user_name} <StatusBadge status={s.status} /></span>}
              actions={acc.sell && <Button size="sm" variant="primary" onClick={() => setClosing(true)}>Close shift</Button>}>
              <p className="mb-3 text-sm text-ink-2">Opened {dateTime(s.opened_at)} with a float of {money(s.opening_cash)} · {s.summary.bills ?? 0} bills · sales {money(s.summary.sales)}{s.summary.due_bills ? ` · ${s.summary.due_bills} with dues` : ''}</p>
              <ShiftTable s={s} />
              <p className="mt-3 text-sm text-ink">Expected cash in the drawer: <b className="tabular">{money(s.summary.expected_cash)}</b></p>
            </Card>
          )}
          <Card title="Recent shifts" pad={false}>
            {q.data.recent.length === 0 ? <Empty icon="Clock" title="No shifts yet" /> : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['Shift', 'Counter', 'Cashier', 'Opened', 'Closed', 'Bills', 'Collected', 'Expected cash', 'Counted', 'Variance', 'Status'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
                  <tbody>{q.data.recent.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="px-3 py-2 font-mono text-xs">{r.code}</td><td className="px-3 py-2 text-ink">{r.counter}</td><td className="px-3 py-2 text-ink-2">{r.user_name}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(r.opened_at)}</td><td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(r.closed_at)}</td>
                      <td className="px-3 py-2 tabular">{r.summary.bills ?? '—'}</td><td className="px-3 py-2 tabular">{money(r.summary.total)}</td>
                      <td className="px-3 py-2 tabular">{money(r.expected_cash ?? r.summary.expected_cash)}</td><td className="px-3 py-2 tabular">{money(r.cash_counted)}</td>
                      <td className="px-3 py-2 tabular">{r.variance == null ? '—' : Math.abs(r.variance) >= 1 ? <Badge tone="red">{money(r.variance)}</Badge> : <Badge tone="green">Tallied</Badge>}</td>
                      <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      {closing && s && <CloseDialog s={s} onClose={() => setClosing(false)} />}
    </PharmShell>
  )
}

function ShiftTable({ s }: { s: ShiftV }) {
  const rows = s.summary.collections
  if (!rows.length) return <p className="text-sm text-ink-3">No collections yet.</p>
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-ink-3"><tr>{['Mode', 'Sales', 'Due collected', 'Refunds', 'Net'].map((h) => <th key={h} className={h === 'Mode' ? 'text-left' : 'text-right'}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((c) => (
        <tr key={c.mode} className="border-t border-line"><td className="py-1">{MODE_LABEL[c.mode] ?? c.mode}</td><td className="text-right tabular">{money(c.sales)}</td>
          <td className="text-right tabular">{money(c.due_collections)}</td><td className="text-right tabular text-red-700 dark:text-red-300">{money(c.refunds)}</td><td className="text-right tabular font-semibold">{money(c.net)}</td></tr>
      ))}</tbody>
    </table>
  )
}

function CloseDialog({ s, onClose }: { s: ShiftV; onClose: () => void }) {
  const qc = useQueryClient()
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [remarks, setRemarks] = useState('')
  const counted = NOTES.reduce((sum, n) => sum + n * (Number(counts[n]) || 0), 0)
  const expected = s.summary.expected_cash ?? 0
  const variance = counted - expected
  const m = useMutation({
    mutationFn: () => api('/op-pharmacy/shift/close', { method: 'POST', body: { denominations: NOTES.map((n) => ({ note: n, count: Number(counts[n]) || 0 })).filter((d) => d.count > 0), cash_counted: counted, remarks: remarks || undefined } }),
    onSuccess: () => { toast.success('Shift closed'); qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title={`Close ${s.counter}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={Math.abs(variance) >= 1 && remarks.trim().length < 5} onClick={() => m.mutate()}>Close shift</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Cash count</h4>
          <div className="grid grid-cols-2 gap-1.5">
            {NOTES.map((n) => (
              <label key={n} className="flex items-center gap-2 text-sm"><span className="w-14 text-right tabular text-ink-2">₹{n} ×</span>
                <Input type="number" min={0} className="h-8 w-20 tabular" value={counts[n] ?? ''} onChange={(e) => setCounts({ ...counts, [n]: e.target.value })} aria-label={`₹${n} notes`} /></label>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <ShiftTable s={s} />
          <dl className="space-y-1 border-t border-line pt-2 text-sm">
            <div className="flex justify-between"><dt className="text-ink-2">Opening float</dt><dd className="tabular">{money(s.opening_cash)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Expected cash</dt><dd className="tabular font-medium">{money(expected)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Counted</dt><dd className="tabular font-medium">{money(counted)}</dd></div>
            <div className="flex justify-between text-base font-semibold"><dt>Variance</dt><dd className={Math.abs(variance) >= 1 ? 'tabular text-red-700 dark:text-red-300' : 'tabular text-emerald-700 dark:text-emerald-300'}>{money(variance)}</dd></div>
          </dl>
          <FieldWrap label="Remarks" required={Math.abs(variance) >= 1}><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Explain any variance" /></FieldWrap>
        </div>
      </div>
    </Modal>
  )
}
