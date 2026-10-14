/**
 * Intake / output flowsheet — quick-add chips, multi-row entry where each row saves itself when complete,
 * and the fluid balance for the clinical day (08:00 → 08:00) or any window with the formulas shown.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, Droplet, Flame, Hash, Loader2, Sigma, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Kbd, Modal, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, nowLocal, number, time } from '@/lib/format'
import { fk } from './api'
import type { FormContext } from './types'

type Kind = 'In' | 'Out' | 'kcal'
type Period = 'clinical_day' | '24h' | '3d' | '7d' | 'stay' | 'custom'

const IN_TYPES = ['Oral', 'IV Fluid', 'IV Medication', 'Blood / Products', 'RT / NG Feed', 'TPN']
const OUT_TYPES = ['Urine', 'Drain', 'RT / NG Aspirate', 'Vomitus', 'Stool', 'Bleeding']
const KCAL_TYPES = ['Oral diet', 'Enteral feed', 'TPN', 'Supplement']
const TYPES: Record<Kind, string[]> = { In: IN_TYPES, Out: OUT_TYPES, kcal: KCAL_TYPES }

interface Row { uid: string; kind: Kind; io_type: string; amount: string; recorded_at: string; remarks: string; state: 'new' | 'saving' | 'saved' | 'error'; error?: string; id?: string }
interface IoEntry {
  id: string; code?: string; kind: Kind; io_type: string; amount: number; recorded_at: string; remarks?: string | null; status: string
  source: 'io' | 'legacy'; recorded_by_name?: string; error_reason?: string | null
}
export interface Balance {
  window: { period: Period; label: string; start: string; end: string; hours: number; length_hours: number; is_current: boolean }
  admission: { id: string; code?: string; started_at?: string; location?: string } | null
  intake: number; output: number; net: number; calories: number; urine: number; entries_count: number
  urine_rate: { ml_kg_h: number | null; weight: number | null; weight_at?: string | null; weight_source?: string | null; hours: number; low: boolean; threshold: number }
  cumulative: { intake: number; output: number; net: number; since?: string | null }
  by_type: { kind: Kind; type: string; amount: number }[]
  by_shift: { shift: string; hours: string; intake: number; output: number; net: number }[]
  by_day: { day: string; intake: number; output: number; net: number; urine: number; entries: number }[]
  entries: IoEntry[]
}

let seq = 0
const blank = (kind: Kind = 'In', type = ''): Row => ({ uid: `r${++seq}`, kind, io_type: type, amount: '', recorded_at: nowLocal(), remarks: '', state: 'new' })
const complete = (r: Row) => !!r.io_type.trim() && Number(r.amount) > 0 && !!r.recorded_at
const ml = (v: number) => `${number(v)} mL`
const KIND_TONE: Record<Kind, string> = {
  In: 'bg-emerald-600 text-white', Out: 'bg-amber-500 text-white', kcal: 'bg-violet-600 text-white',
}

export function IoFlowsheet({ patientId, encounterId, readOnly }: FormContext & { readOnly?: boolean }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Row[]>(() => [blank()])
  const [view, setView] = useState<{ period: Period; start?: string; end?: string }>({ period: 'clinical_day' })
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null)
  const [voiding, setVoiding] = useState<IoEntry | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const query = { patient_id: patientId, encounter_id: encounterId, period: view.period, start: view.start, end: view.end }
  const bal = useQuery({
    queryKey: fk.io(query),
    queryFn: () => api<Balance>('/forms/io/balance', { query }),
    refetchInterval: 60_000,
  })
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'io'] }), [qc])

  const update = (uid: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch, state: patch.state ?? (r.state === 'saved' ? 'saved' : 'new') } : r)))

  // keep one blank row at the bottom
  useEffect(() => {
    const last = rows[rows.length - 1]
    if (!last || last.state === 'saved' || complete(last)) setRows((rs) => [...rs, blank(last?.kind ?? 'In')])
  }, [rows])

  const saveRows = useCallback(async (list: Row[]) => {
    const todo = list.filter((r) => r.state !== 'saved' && r.state !== 'saving' && complete(r))
    if (!todo.length) return 0
    setRows((rs) => rs.map((r) => (todo.some((t) => t.uid === r.uid) ? { ...r, state: 'saving', error: undefined } : r)))
    try {
      const res = await api<{ rows: (IoEntry & { client_id: string })[] }>('/forms/io', {
        method: 'POST',
        body: { patient_id: patientId, encounter_id: encounterId, rows: todo.map((r) => ({ kind: r.kind, io_type: r.io_type.trim(), amount: Number(r.amount), recorded_at: r.recorded_at, remarks: r.remarks || null, client_id: r.uid })) },
      })
      const ids = new Map(res.rows.map((r) => [r.client_id, r.id]))
      setRows((rs) => rs.map((r) => (ids.has(r.uid) ? { ...r, state: 'saved', id: ids.get(r.uid) } : r)))
      refresh()
      return res.rows.length
    } catch (e) {
      setRows((rs) => rs.map((r) => (todo.some((t) => t.uid === r.uid) ? { ...r, state: 'error', error: errorMessage(e) } : r)))
      toast.error(errorMessage(e))
      return 0
    }
  }, [patientId, encounterId, refresh])

  const saveAll = async () => {
    const pending = rows.filter((r) => r.state !== 'saved' && (r.io_type || r.amount))
    const incomplete = pending.filter((r) => !complete(r))
    const n = await saveRows(rows)
    if (n) toast.success(`${n} entr${n > 1 ? 'ies' : 'y'} recorded`)
    if (incomplete.length) toast.error(`${incomplete.length} row${incomplete.length > 1 ? 's need' : ' needs'} a type and an amount`)
  }

  const quickAdd = (kind: Kind, type: string) => {
    const empty = rows.find((r) => r.state === 'new' && !r.io_type && !r.amount)
    const uid = empty?.uid ?? `r${++seq}`
    if (empty) update(uid, { kind, io_type: type, recorded_at: nowLocal() })
    else setRows((rs) => [...rs, { ...blank(kind, type), uid }])
    window.setTimeout(() => grid.current?.querySelector<HTMLInputElement>(`[data-row="${uid}"] input[name="amount"]`)?.focus(), 30)
  }

  // row saves itself when focus leaves it
  const onRowBlur = (r: Row) => (e: React.FocusEvent<HTMLTableRowElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    if (r.state !== 'saved' && complete(r)) void saveRows([r])
  }
  const onKey = (r: Row) => (e: KeyboardEvent<HTMLElement>) => {
    const tgt = e.target as HTMLElement
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void saveAll(); return }
    if (tgt.dataset.kind !== undefined && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'i' || k === 'o' || k === 'k') { e.preventDefault(); update(r.uid, { kind: k === 'i' ? 'In' : k === 'o' ? 'Out' : 'kcal' }); return }
    }
    if (e.key === 'Enter' && tgt.tagName === 'INPUT') {
      e.preventDefault()
      const cells = Array.from(grid.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])
      const i = cells.indexOf(tgt)
      cells[i + 1]?.focus()
    }
  }

  const shift = (dir: -1 | 1) => {
    const w = bal.data?.window
    if (!w) return
    const ms = w.length_hours * 3.6e6 * dir
    const s = new Date(new Date(w.start).getTime() + ms).toISOString()
    const e = new Date(new Date(w.end).getTime() + ms).toISOString()
    if (view.period === 'clinical_day') setView({ period: 'clinical_day', start: s })
    else if (view.period === 'custom') setView({ period: 'custom', start: s, end: e })
    else setView({ period: view.period, end: e })
  }

  const b = bal.data
  const canWrite = !readOnly
  return (
    <div className="space-y-4">
      {canWrite && (
        <Card pad={false}>
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-2.5">
            <div>
              <h3 className="text-sm font-semibold text-ink">Record intake / output</h3>
              <p className="text-xs text-ink-2">Enter several at once — each row saves itself when complete and you leave it.</p>
            </div>
            <Button size="sm" variant="primary" icon="Save" onClick={() => void saveAll()}
              disabled={!rows.some((r) => r.state !== 'saved' && complete(r))}>Save all</Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">In</span>
            {IN_TYPES.map((t) => (
              <button key={t} type="button" onClick={() => quickAdd('In', t)}
                className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-600/20 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-200">{t}</button>
            ))}
            <span className="ml-3 mr-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Out</span>
            {OUT_TYPES.map((t) => (
              <button key={t} type="button" onClick={() => quickAdd('Out', t)}
                className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-600/25 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-200">{t}</button>
            ))}
          </div>
          <div ref={grid} className="overflow-x-auto px-4 py-3">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-xs text-ink-2">
                <tr className="border-b border-line">
                  <th className="w-8 py-1.5 text-left">#</th><th className="w-40 text-left">Kind</th><th className="text-left">Type</th>
                  <th className="w-32 text-left">Amount</th><th className="w-52 text-left">Time</th><th className="text-left">Remarks</th><th className="w-24 text-left">Status</th><th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const locked = r.state === 'saved' || r.state === 'saving'
                  return (
                    <tr key={r.uid} data-row={r.uid} className="border-b border-line/60 align-middle" onBlur={onRowBlur(r)} onKeyDown={onKey(r)}>
                      <td className="py-1.5 text-xs text-ink-3">{i + 1}</td>
                      <td className="pr-2">
                        <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5" role="radiogroup" aria-label="Kind">
                          {(['In', 'Out', 'kcal'] as Kind[]).map((k) => (
                            <button key={k} type="button" data-kind="" data-cell={k === r.kind ? '' : undefined} disabled={locked} role="radio" aria-checked={r.kind === k}
                              onClick={() => update(r.uid, { kind: k })}
                              className={cn('rounded-md px-2 py-0.5 text-xs font-medium', r.kind === k ? KIND_TONE[k] : 'text-ink-2 hover:text-ink')}>{k}</button>
                          ))}
                        </div>
                      </td>
                      <td className="pr-2">
                        <Input data-cell="" list={`io-types-${r.kind}`} value={r.io_type} disabled={locked} placeholder={r.kind === 'Out' ? 'Urine, drain…' : r.kind === 'kcal' ? 'Enteral feed…' : 'Oral, IV fluid…'}
                          onChange={(e) => update(r.uid, { io_type: e.target.value })} className="h-8" aria-label="Type" />
                      </td>
                      <td className="pr-2">
                        <div className="relative">
                          <Input data-cell="" name="amount" type="number" inputMode="decimal" min={0} value={r.amount} disabled={locked}
                            onChange={(e) => update(r.uid, { amount: e.target.value })} className="h-8 pr-10 tabular" aria-label="Amount" />
                          <span className="pointer-events-none absolute right-2 top-1.5 text-xs text-ink-3">{r.kind === 'kcal' ? 'kcal' : 'mL'}</span>
                        </div>
                      </td>
                      <td className="pr-2">
                        <Input data-cell="" type="datetime-local" value={r.recorded_at} disabled={locked} onChange={(e) => update(r.uid, { recorded_at: e.target.value })} className="h-8" aria-label="Time" />
                      </td>
                      <td className="pr-2">
                        <Input data-cell="" value={r.remarks} disabled={locked} placeholder="Optional" onChange={(e) => update(r.uid, { remarks: e.target.value })} className="h-8" aria-label="Remarks" />
                      </td>
                      <td className="text-xs">
                        {r.state === 'saving' && <span className="inline-flex items-center gap-1 text-ink-3"><Loader2 className="size-3.5 animate-spin" /> Saving</span>}
                        {r.state === 'saved' && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><Check className="size-3.5" /> Saved</span>}
                        {r.state === 'error' && <span className="text-red-600" title={r.error}>Not saved</span>}
                        {r.state === 'new' && <span className="text-ink-3">{complete(r) ? 'Ready' : '—'}</span>}
                      </td>
                      <td>
                        {r.state !== 'saving' && (r.io_type || r.amount || r.state === 'saved') && (
                          <button type="button" className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Clear row"
                            onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}><X className="size-4" /></button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {(['In', 'Out', 'kcal'] as Kind[]).map((k) => <datalist key={k} id={`io-types-${k}`}>{TYPES[k].map((t) => <option key={t} value={t} />)}</datalist>)}
            <p className="mt-2 text-xs text-ink-3"><Kbd>Enter</Kbd> next cell · <Kbd>I</Kbd> / <Kbd>O</Kbd> / <Kbd>K</Kbd> switch kind · <Kbd>Ctrl+S</Kbd> save all · a row saves itself when you leave it</p>
          </div>
        </Card>
      )}

      <Card pad={false}>
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-2.5">
          <div>
            <h3 className="text-sm font-semibold text-ink">Fluid balance</h3>
            <p className="text-xs text-ink-2">Intake, output and the balance — worked out by shift and by day.</p>
          </div>
          <Button size="sm" variant="secondary" icon="Printer" disabled={!b}
            onClick={() => window.open(`/print/io-chart?${new URLSearchParams(Object.entries({ patient: patientId, encounter: encounterId ?? '', period: view.period, start: b?.window.start ?? '', end: b?.window.end ?? '' }).filter(([, v]) => v)).toString()}`, '_blank')}>
            Print chart
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <div className="inline-flex flex-wrap rounded-lg border border-line-2 bg-surface-2 p-0.5">
            {([['clinical_day', 'Clinical day'], ['24h', '24 h'], ['3d', '3 days'], ['7d', '7 days'], ['stay', 'Whole stay'], ['custom', 'Custom']] as [Period, string][]).map(([k, l]) => (
              <button key={k} type="button" onClick={() => {
                if (k === 'custom') { const s = b?.window.start ?? new Date().toISOString(); const e = b?.window.end ?? new Date().toISOString(); setCustom({ start: s.slice(0, 16), end: e.slice(0, 16) }) }
                else setView({ period: k })
              }}
                className={cn('rounded-md px-2.5 py-1 text-xs font-medium', view.period === k ? 'bg-brand-800 text-white dark:bg-brand-600' : 'text-ink-2 hover:text-ink')}>{l}</button>
            ))}
          </div>
          <Button size="xs" variant="secondary" disabled={!b || view.period === 'stay'} onClick={() => shift(-1)}>◂ Previous</Button>
          <Button size="xs" variant="secondary" disabled={!b || view.period === 'stay' || b.window.is_current || new Date(b.window.end) > new Date()} onClick={() => shift(1)}>Next ▸</Button>
          {b && <span className="ml-auto text-xs font-medium text-ink-2">{dateTime(b.window.start)} → {dateTime(b.window.end)}</span>}
        </div>
        {bal.isLoading && <Spinner label="Working out the balance…" />}
        {bal.error && <div className="px-4 pb-4"><ErrorBox error={bal.error} /></div>}
        {b && <BalanceView b={b} readOnly={readOnly} onVoid={setVoiding} />}
      </Card>
      {custom && (
        <Modal open onClose={() => setCustom(null)} title="Custom window" size="sm"
          footer={<><Button variant="ghost" onClick={() => setCustom(null)}>Cancel</Button><Button variant="primary" onClick={() => { setView({ period: 'custom', start: custom.start, end: custom.end }); setCustom(null) }}>Show</Button></>}>
          <div className="grid gap-3">
            <FieldWrap label="From"><Input type="datetime-local" value={custom.start} onChange={(e) => setCustom({ ...custom, start: e.target.value })} /></FieldWrap>
            <FieldWrap label="To"><Input type="datetime-local" value={custom.end} onChange={(e) => setCustom({ ...custom, end: e.target.value })} /></FieldWrap>
          </div>
        </Modal>
      )}
      {voiding && <VoidModal entry={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); refresh() }} />}
    </div>
  )
}

function Tile({ icon, label, value, hint, tone = 'default' }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'default' | 'green' | 'violet' | 'blue' | 'red' }) {
  const t = { default: 'border-line bg-surface', green: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10', violet: 'border-violet-200 bg-violet-50/60 dark:border-violet-500/30 dark:bg-violet-500/10', blue: 'border-sky-200 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-500/10', red: 'border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10' }[tone]
  return (
    <div className={cn('rounded-xl border px-3 py-2', t)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-2">{icon}{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular text-ink">{value}</div>
      {hint && <div className="text-xs text-ink-3">{hint}</div>}
    </div>
  )
}

export function BalanceView({ b, readOnly, onVoid, print }: { b: Balance; readOnly?: boolean; onVoid?: (e: IoEntry) => void; print?: boolean }) {
  const net = b.net
  const netLabel = net === 0 ? 'even' : net > 0 ? 'positive' : 'negative'
  const rate = b.urine_rate
  const live = useMemo(() => b.entries.filter((e) => e.status === 'Recorded'), [b.entries])
  return (
    <div className="space-y-4 px-4 pb-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_minmax(0,1fr)]">
        <div className="flex items-stretch gap-2 rounded-xl border border-line p-3">
          <div className="flex-1 text-center"><div className="flex items-center justify-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300"><ArrowDown className="size-3.5" /> Intake</div><div className="text-2xl font-semibold tabular text-ink">{number(b.intake)}</div><div className="text-xs text-ink-3">mL</div></div>
          <div className="self-center text-ink-3">−</div>
          <div className="flex-1 text-center"><div className="flex items-center justify-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"><ArrowUp className="size-3.5" /> Output</div><div className="text-2xl font-semibold tabular text-ink">{number(b.output)}</div><div className="text-xs text-ink-3">mL</div></div>
          <div className="self-center text-ink-3">=</div>
          <div className="flex-1 rounded-lg bg-surface-2 text-center"><div className="text-xs font-medium text-ink-2">Net</div><div className={cn('text-2xl font-semibold tabular', net > 0 ? 'text-sky-700 dark:text-sky-300' : net < 0 ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>{net > 0 ? '+' : ''}{number(net)}</div><div className="text-xs text-ink-3">{netLabel}</div></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<Droplet className="size-3.5" />} label="Urine output" tone={rate.low ? 'red' : 'green'} value={rate.ml_kg_h !== null ? `${rate.ml_kg_h} mL/kg/h` : ml(b.urine)}
            hint={rate.ml_kg_h !== null ? <>{ml(b.urine)} · {rate.low ? <b className="text-red-700 dark:text-red-300">Low (&lt; {rate.threshold})</b> : 'Adequate'}</> : 'Chart a weight for mL/kg/h'} />
          <Tile icon={<Sigma className="size-3.5" />} label="Cumulative · whole stay" tone="blue" value={`${b.cumulative.net > 0 ? '+' : ''}${ml(b.cumulative.net)}`} hint={`${ml(b.cumulative.intake)} in · ${ml(b.cumulative.output)} out`} />
          <Tile icon={<Flame className="size-3.5" />} label="Calories" tone="violet" value={`${number(b.calories)} kcal`} hint="Not part of the fluid balance" />
          <Tile icon={<Hash className="size-3.5" />} label="Entries" value={b.entries_count} hint={`over ${b.window.hours} h`} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink-2">Worked out</span>
        <span className="rounded-md bg-surface-2 px-2 py-1 ring-1 ring-line"><b>NET</b> {ml(b.intake)} − {ml(b.output)} = {ml(net)}</span>
        <span className="rounded-md bg-surface-2 px-2 py-1 ring-1 ring-line"><b>URINE RATE</b> {ml(b.urine)} ÷ {rate.weight ? `${rate.weight} kg` : <i>weight</i>} ÷ {rate.hours} h
          {rate.ml_kg_h !== null ? ` = ${rate.ml_kg_h} mL/kg/h` : ' — no weight charted'} · low below {rate.threshold}
          {rate.weight_at && <span className="text-ink-3"> (weight {dateTime(rate.weight_at)}, {rate.weight_source})</span>}</span>
        <span className="rounded-md bg-surface-2 px-2 py-1 ring-1 ring-line"><b>CUMULATIVE</b> Σ entries since {b.cumulative.since ? dateTime(b.cumulative.since) : 'admission'} = {ml(b.cumulative.net)}</span>
      </div>
      {!b.entries.length ? (
        <div className="rounded-xl border border-dashed border-line-2 py-8 text-center">
          <Empty icon="Droplets" title="Nothing recorded in this period">Use the quick-add chips above to chart intake and output.</Empty>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-1.5 text-left">Time</th><th className="px-3 py-1.5 text-left">Kind</th><th className="px-3 py-1.5 text-left">Type</th><th className="px-3 py-1.5 text-right">Amount</th><th className="px-3 py-1.5 text-left">Remarks</th><th className="px-3 py-1.5 text-left">By</th>{!print && !readOnly && <th className="w-8" />}</tr></thead>
              <tbody>
                {b.entries.map((e) => {
                  const struck = e.status !== 'Recorded'
                  return (
                    <tr key={e.id} className={cn('border-t border-line', struck && 'text-ink-3 line-through')}>
                      <td className="px-3 py-1.5 tabular">{dateTime(e.recorded_at)}</td>
                      <td className="px-3 py-1.5"><Badge tone={e.kind === 'In' ? 'green' : e.kind === 'Out' ? 'amber' : 'violet'}>{e.kind}</Badge></td>
                      <td className="px-3 py-1.5">{e.io_type}{e.source === 'legacy' && <span className="ml-1 text-[10px] text-ink-3">(shift chart)</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular">{number(e.amount)} {e.kind === 'kcal' ? 'kcal' : 'mL'}</td>
                      <td className="px-3 py-1.5 text-ink-2">{struck ? `Entered in error: ${e.error_reason ?? ''}` : e.remarks}</td>
                      <td className="px-3 py-1.5 text-xs text-ink-2">{e.recorded_by_name ?? '—'}</td>
                      {!print && !readOnly && (
                        <td className="px-1">{!struck && e.source === 'io' && onVoid && (
                          <button type="button" className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600" title="Mark entered in error" onClick={() => onVoid(e)}><Trash2 className="size-4" /></button>
                        )}</td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="space-y-3">
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-1.5 text-left">Shift</th><th className="px-2 py-1.5 text-right">In</th><th className="px-2 py-1.5 text-right">Out</th><th className="px-3 py-1.5 text-right">Net</th></tr></thead>
                <tbody>{b.by_shift.map((s) => (
                  <tr key={s.shift} className="border-t border-line"><td className="px-3 py-1.5">{s.shift} <span className="text-xs text-ink-3">{s.hours}</span></td>
                    <td className="px-2 py-1.5 text-right tabular">{number(s.intake)}</td><td className="px-2 py-1.5 text-right tabular">{number(s.output)}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular">{s.net > 0 ? '+' : ''}{number(s.net)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="rounded-xl border border-line p-3">
              <div className="mb-1 text-xs font-medium text-ink-2">By type</div>
              {b.by_type.map((t) => (
                <div key={`${t.kind}-${t.type}`} className="flex items-center justify-between py-0.5 text-sm">
                  <span><Badge tone={t.kind === 'In' ? 'green' : t.kind === 'Out' ? 'amber' : 'violet'}>{t.kind}</Badge> {t.type}</span>
                  <span className="tabular">{number(t.amount)} {t.kind === 'kcal' ? 'kcal' : 'mL'}</span>
                </div>
              ))}
              {!live.length && <div className="text-xs text-ink-3">—</div>}
            </div>
          </div>
        </div>
      )}
      {b.by_day.length > 1 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-1.5 text-left">Clinical day (08:00 → 08:00)</th><th className="px-3 py-1.5 text-right">Intake</th><th className="px-3 py-1.5 text-right">Output</th><th className="px-3 py-1.5 text-right">Urine</th><th className="px-3 py-1.5 text-right">Net</th><th className="px-3 py-1.5 text-right">Entries</th></tr></thead>
            <tbody>{b.by_day.map((d) => (
              <tr key={d.day} className="border-t border-line"><td className="px-3 py-1.5">{d.day}</td><td className="px-3 py-1.5 text-right tabular">{number(d.intake)}</td>
                <td className="px-3 py-1.5 text-right tabular">{number(d.output)}</td><td className="px-3 py-1.5 text-right tabular">{number(d.urine)}</td>
                <td className="px-3 py-1.5 text-right font-medium tabular">{d.net > 0 ? '+' : ''}{number(d.net)}</td><td className="px-3 py-1.5 text-right tabular">{d.entries}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {!print && <p className="text-[11px] text-ink-3">Last refreshed {time(new Date().toISOString())}. Struck-out entries are excluded from every total.</p>}
    </div>
  )
}

function VoidModal({ entry, onClose, onDone }: { entry: IoEntry; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { await api(`/forms/io/${entry.id}/void`, { method: 'POST', body: { reason } }); toast.success('Entry struck out'); onDone() } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title="Mark entry as entered in error" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => void go()}>Strike out</Button></>}>
      <p className="mb-3 text-sm text-ink-2">{entry.kind} · {entry.io_type} · {number(entry.amount)} {entry.kind === 'kcal' ? 'kcal' : 'mL'} at {dateTime(entry.recorded_at)}. The entry stays visible, struck out, and is excluded from totals.</p>
      <FieldWrap label="Reason" required><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Charted on the wrong patient" /></FieldWrap>
    </Modal>
  )
}

