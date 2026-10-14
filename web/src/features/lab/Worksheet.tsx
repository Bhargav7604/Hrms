import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { api, ApiError, errorMessage } from '@/lib/api'
import { date, dateTime } from '@/lib/format'
import { FlagBadge, liveFlag, PriorityBadge, TatCell } from '@/pages/bespoke/lab-worklist'
import { Kpi, LabShell, useLabAccess } from './shell'
import type { SheetRow } from './types'

interface Res {
  rows: SheetRow[]; sections: string[]; analyzers: { id: string; name: string; section?: string | null; status?: string | null }[]
  counts: { entry: number; verify: number; not_received: number; delta_flags: number }; generated_at: string
}
interface Draft { values: Record<string, string>; iface: Record<string, string>; notes: Record<string, string>; result: string; impression: string; dirty: boolean }

const num = (v?: string | null) => {
  const n = Number(String(v ?? '').replace(/,/g, '').replace(/^[<>=≤≥\s]+/, ''))
  return v == null || String(v).trim() === '' || Number.isNaN(n) ? null : n
}

function initDraft(r: SheetRow): Draft {
  const existing = new Map(r.result_values.map((v) => [v.parameter.toLowerCase(), v.value ?? '']))
  const values: Record<string, string> = {}
  for (const p of r.parameters) values[p.parameter] = existing.get(p.parameter.toLowerCase()) ?? ''
  for (const v of r.result_values) if (!(v.parameter in values)) values[v.parameter] = v.value ?? ''
  return { values, iface: { ...(r.interface_values ?? {}) }, notes: { ...(r.param_notes ?? {}) }, result: r.result ?? '', impression: r.impression ?? '', dirty: false }
}

export default function ResultWorksheet() {
  const acc = useLabAccess()
  const qc = useQueryClient()
  const [stage, setStage] = useState<'entry' | 'verify' | 'all'>('entry')
  const [section, setSection] = useState('')
  const [analyzer, setAnalyzer] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [review, setReview] = useState<SheetRow | null>(null)
  const inputs = useRef<HTMLInputElement[]>([])

  const list = useQuery({
    queryKey: ['x', 'lab', 'worksheet', stage, section, analyzer, dq],
    queryFn: () => api<Res>('/lab/worksheet', { query: { stage, section: section || undefined, analyzer: analyzer || undefined, q: dq || undefined } }),
    placeholderData: (p) => p,
  })
  const rows = useMemo(() => list.data?.rows ?? [], [list.data])
  useEffect(() => {
    setDrafts((cur) => {
      const next: Record<string, Draft> = {}
      for (const r of rows) next[r.id] = cur[r.id]?.dirty ? cur[r.id] : initDraft(r)
      return next
    })
  }, [rows])

  const patch = (id: string, f: (d: Draft) => Draft) => setDrafts((cur) => ({ ...cur, [id]: { ...f(cur[id]), dirty: true } }))
  const dirty = rows.filter((r) => drafts[r.id]?.dirty)
  const toVerify = rows.filter((r) => picked.has(r.id))

  const save = useMutation({
    mutationFn: ({ ids, verify }: { ids: string[]; verify: boolean }) => api<{ saved: { code: string; status: string; critical: boolean; delta_checks: { failed: boolean }[]; reflex_suggestions: { status: string }[] }[] }>('/lab/worksheet/save', {
      method: 'POST',
      body: {
        verify,
        entries: ids.map((id) => {
          const d = drafts[id]
          const isDirty = d?.dirty
          return {
            order_id: id,
            values: isDirty ? Object.entries(d.values).filter(([, v]) => v.trim()).map(([parameter, value]) => ({ parameter, value: value.trim() })) : [],
            interface_values: isDirty ? d.iface : undefined, param_notes: isDirty ? d.notes : undefined,
            result: isDirty ? d.result || undefined : undefined, impression: isDirty ? d.impression || undefined : undefined,
          }
        }),
      },
    }),
    onSuccess: (r, v) => {
      const crit = r.saved.filter((s) => s.critical).length
      const delta = r.saved.filter((s) => s.delta_checks.some((d) => d.failed)).length
      const reflex = r.saved.filter((s) => s.reflex_suggestions.some((x) => x.status === 'Suggested')).length
      toast.success(`${v.verify ? 'Authorised' : 'Saved'} ${r.saved.length} test${r.saved.length > 1 ? 's' : ''}`
        + `${crit ? ` · ${crit} critical — ward alerted` : ''}${delta ? ` · ${delta} delta flag${delta > 1 ? 's' : ''}` : ''}${reflex ? ` · ${reflex} reflex suggestion${reflex > 1 ? 's' : ''}` : ''}`)
      setDrafts((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !v.ids.includes(k))))
      setPicked(new Set())
      qc.invalidateQueries({ queryKey: ['x', 'lab'] })
      qc.invalidateQueries({ queryKey: ['x', 'orders'] })
    },
    onError: (e) => {
      toast.error(errorMessage(e), { duration: 10000 })
      if (e instanceof ApiError && e.code === 'DELTA_HOLD') {
        const id = (e.details as { order_id?: string } | undefined)?.order_id
        const r = rows.find((x) => x.id === id)
        if (r) setReview(r)
      }
    },
  })

  const focusNext = (el: HTMLInputElement) => {
    const all = inputs.current.filter((x) => x?.isConnected)
    const i = all.indexOf(el)
    all[i + 1]?.focus()
  }
  const c = list.data?.counts

  return (
    <LabShell screen="results" icon="ClipboardPen" title="Result entry & verify"
      subtitle="Worksheets by section or analyser. Reference ranges follow the patient's age and sex; changes against the previous result are delta-checked, and reflex rules suggest follow-up tests."
      actions={c && (
        <div className="flex flex-wrap gap-2">
          <Kpi icon="ClipboardPen" label="Awaiting results" value={c.entry} />
          <Kpi icon="ShieldCheck" label="To authorise" value={c.verify} />
          <Kpi icon="PackageX" label="Not yet received" value={c.not_received} />
          <Kpi icon="Activity" label="Delta flags" value={c.delta_flags} tone={c.delta_flags ? 'alert' : undefined} />
        </div>
      )}>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <Segmented value={stage} onChange={(s) => { setStage(s); setPicked(new Set()) }} options={[{ key: 'entry', label: 'Result entry' }, { key: 'verify', label: 'To authorise' }, { key: 'all', label: 'All open' }]} />
        <Select value={section} onChange={(e) => setSection(e.target.value)} className="w-48" aria-label="Section">
          <option value="">All sections</option>{(list.data?.sections ?? []).map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Select value={analyzer} onChange={(e) => setAnalyzer(e.target.value)} className="w-52" aria-label="Analyser">
          <option value="">All analysers</option>{(list.data?.analyzers ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.status && a.status !== 'Online' ? ` (${a.status})` : ''}</option>)}
        </Select>
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 font-mono" placeholder="Barcode / order / UHID / patient / test" aria-label="Search" />
        </div>
        {acc.benchEdit && <Button icon="FileInput" onClick={() => setImporting(true)}>Import analyser output</Button>}
        <Button variant="ghost" className="px-2.5" aria-label="Refresh" onClick={() => list.refetch()}><RefreshCw className={cn('size-4', list.isFetching && 'animate-spin')} /></Button>
      </div>

      {list.isLoading && <Spinner />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data && rows.length === 0 && <Empty icon="ClipboardCheck" title={stage === 'verify' ? 'Nothing awaiting authorisation' : 'Nothing awaiting results'}>Try another section, analyser or stage.</Empty>}

      <div className="space-y-3 pb-20">
        {rows.map((r) => drafts[r.id] && (
          <SheetCard key={r.id} r={r} d={drafts[r.id]} edit={acc.benchEdit} verify={acc.verify} picked={picked.has(r.id)}
            onPick={(on) => setPicked((cur) => { const n = new Set(cur); if (on) n.add(r.id); else n.delete(r.id); return n })}
            onPatch={(f) => patch(r.id, f)} register={(el) => { if (el && !inputs.current.includes(el)) inputs.current.push(el) }}
            onNext={focusNext} onReview={() => setReview(r)} onReset={() => setDrafts((cur) => ({ ...cur, [r.id]: initDraft(r) }))} />
        ))}
      </div>

      {(dirty.length > 0 || toVerify.length > 0) && acc.benchEdit && (
        <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 py-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
            <span className="text-sm text-ink">{dirty.length > 0 && <><b>{dirty.length}</b> edited</>}{dirty.length > 0 && toVerify.length > 0 && ' · '}{toVerify.length > 0 && <><b>{toVerify.length}</b> ticked to authorise</>}</span>
            <span className="ml-auto" />
            {dirty.length > 0 && <Button variant="ghost" onClick={() => setDrafts(Object.fromEntries(rows.map((r) => [r.id, initDraft(r)])))}>Discard edits</Button>}
            {dirty.length > 0 && <Button variant="primary" icon="Save" loading={save.isPending && !save.variables?.verify} onClick={() => save.mutate({ ids: dirty.map((r) => r.id), verify: false })}>Save {dirty.length}</Button>}
            {acc.verify && (dirty.length > 0 || toVerify.length > 0) && (
              <Button variant="success" icon="ShieldCheck" loading={save.isPending && save.variables?.verify}
                onClick={() => save.mutate({ ids: [...new Set([...dirty, ...toVerify].map((r) => r.id))], verify: true })}>
                Save & authorise {new Set([...dirty, ...toVerify].map((r) => r.id)).size}
              </Button>
            )}
          </div>
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onApply={(matched) => {
        setDrafts((cur) => {
          const next = { ...cur }
          for (const m of matched) {
            const d = next[m.order_id]
            if (!d) continue
            const values = { ...d.values }
            for (const [p, v] of Object.entries(m.values)) if (!values[p]?.trim()) values[p] = v
            next[m.order_id] = { ...d, values, iface: { ...d.iface, ...m.values }, dirty: true }
          }
          return next
        })
        const missing = matched.filter((m) => !drafts[m.order_id]).length
        toast.success(`Applied analyser values to ${matched.length - missing} test${matched.length - missing === 1 ? '' : 's'}${missing ? ` · ${missing} not on this worksheet (change the filters)` : ''}`)
      }} />}
      {review && <DeltaReview r={review} onClose={() => setReview(null)} />}
    </LabShell>
  )
}

function SheetCard({ r, d, edit, verify, picked, onPick, onPatch, register, onNext, onReview, onReset }: {
  r: SheetRow; d: Draft; edit: boolean; verify: boolean; picked: boolean; onPick: (on: boolean) => void; onPatch: (f: (d: Draft) => Draft) => void
  register: (el: HTMLInputElement | null) => void; onNext: (el: HTMLInputElement) => void; onReview: () => void; onReset: () => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState(!!(r.result || r.impression) || r.parameters.length === 0)
  const params = new Map(r.parameters.map((p) => [p.parameter.toLowerCase(), p]))
  const prev = r.previous[0]
  const prevMap = new Map((prev?.values ?? []).map((v) => [v.parameter.toLowerCase(), v]))
  const names = Object.keys(d.values)
  const holds = (r.delta_checks ?? []).filter((x) => x.hold)
  const reflex = (r.reflex_suggestions ?? []).filter((x) => x.status === 'Suggested')
  const act = useMutation({
    mutationFn: ({ rule_id, action }: { rule_id: string; action: 'order' | 'dismiss' }) => api(`/lab/worksheet/${r.id}/reflex`, { method: 'POST', body: { rule_id, action } }),
    onSuccess: (_, v) => { toast.success(v.action === 'order' ? 'Reflex test ordered' : 'Suggestion dismissed'); qc.invalidateQueries({ queryKey: ['x', 'lab'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const flagged = names.map((n) => liveFlag(d.values[n] ?? '', params.get(n.toLowerCase())))
  const critical = flagged.filter((f) => f?.startsWith('Critical')).length

  return (
    <article className={cn('rounded-xl border bg-surface', critical ? 'border-red-400 dark:border-red-500/50' : d.dirty ? 'border-brand-600/50' : 'border-line')}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        {verify && r.status === 'Resulted' && !d.dirty && (
          <input type="checkbox" className="size-4 accent-brand-700" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Authorise ${r.code}`} />
        )}
        <PriorityBadge priority={r.priority} />
        <span className="font-semibold text-ink">{r.test.name}</span>
        <span className="text-xs text-ink-3">{r.test.section}{r.method && ` · ${r.method}`}</span>
        <span className="font-mono text-xs text-ink-2">{r.code}{r.sample_barcode && ` · ${r.sample_barcode}`}</span>
        <Link to={`/patients/${r.patient.id}`} className="text-sm text-ink hover:underline">{r.patient.name}</Link>
        <span className="text-xs text-ink-2">{r.patient.age_label} {r.patient.sex?.[0] ?? ''} · {r.location}</span>
        <span className="ml-auto flex items-center gap-2">
          {r.status === 'Collected' && <Badge tone="amber">Not received — saving receives it</Badge>}
          {r.critical && <Badge tone="red">Critical</Badge>}
          <StatusBadge status={r.status} /><TatCell r={r} />
        </span>
      </header>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="text-[11px] text-ink-3">
            <tr>{['Parameter', 'Result', 'Flag', 'Reference (this patient)', 'Interface', `Previous${prev ? ` · ${date(prev.verified_at)}` : ''}`, 'Δ', 'Note'].map((h) => <th key={h} className="px-2.5 pb-1 pt-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {names.map((n, i) => {
              const p = params.get(n.toLowerCase())
              const f = flagged[i]
              const pv = prevMap.get(n.toLowerCase())
              const cur = num(d.values[n])
              const old = num(pv?.value)
              const rule = r.delta_rules[n.toLowerCase()]
              const pct = cur != null && old != null && old !== 0 ? ((cur - old) / Math.abs(old)) * 100 : null
              const deltaFail = !!rule && cur != null && old != null && ((rule.max_change_percent != null && pct != null && Math.abs(pct) > rule.max_change_percent)
                || (rule.max_change_absolute != null && Math.abs(cur - old) > rule.max_change_absolute))
              return (
                <tr key={n} className={cn('border-t border-line', f?.startsWith('Critical') && 'bg-red-50 dark:bg-red-500/10')}>
                  <td className="px-2.5 py-1 text-ink">{n}<div className="text-[11px] text-ink-3">{p?.unit ?? ''}</div></td>
                  <td className="w-36 px-2.5 py-1">
                    {edit ? (
                      <Input ref={register} className={cn('h-8 tabular', f && f !== 'Normal' && 'border-red-400 font-semibold text-red-700 dark:text-red-300')}
                        value={d.values[n] ?? ''} aria-label={`${r.code} ${n}`}
                        onChange={(e) => { const v = e.target.value; onPatch((x) => ({ ...x, values: { ...x.values, [n]: v } })) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onNext(e.currentTarget) } }} />
                    ) : <span className="tabular font-medium">{d.values[n] || '—'}</span>}
                  </td>
                  <td className="px-2.5 py-1"><FlagBadge flag={f} /></td>
                  <td className="px-2.5 py-1 text-ink-2" title={p?.range_basis ?? 'Test default range'}>{p?.ref_range ?? '—'}{p?.range_basis && <span className="ml-1 text-[10px] text-ink-3">({p.range_basis})</span>}</td>
                  <td className="px-2.5 py-1 tabular text-ink-2">{d.iface[n] ?? '—'}</td>
                  <td className="px-2.5 py-1 tabular text-ink-2">{pv?.value ?? '—'}</td>
                  <td className="px-2.5 py-1 tabular">
                    {pct == null ? <span className="text-ink-3">—</span>
                      : <span className={cn(deltaFail ? 'rounded bg-red-100 px-1 font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'text-ink-2')}
                          title={rule ? `Limit ${rule.max_change_percent ?? '—'}% / ±${rule.max_change_absolute ?? '—'} within ${rule.window_days ?? 30} days` : 'No delta rule'}>
                          {pct > 0 ? '+' : ''}{pct.toFixed(0)}%{deltaFail && ' Δ'}
                        </span>}
                  </td>
                  <td className="w-48 px-2.5 py-1">
                    {edit ? <Input className="h-8 text-xs" value={d.notes[n] ?? ''} placeholder={p?.note ?? ''} aria-label={`Note for ${n}`}
                      onChange={(e) => { const v = e.target.value; onPatch((x) => ({ ...x, notes: { ...x.notes, [n]: v } })) }} />
                      : <span className="text-xs text-ink-2">{d.notes[n]}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 px-3 py-2">
        {critical > 0 && <p className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white">{critical} critical value{critical > 1 ? 's' : ''} — saving alerts the treating team immediately.</p>}
        {holds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <b>Delta hold:</b> {holds.map((h) => `${h.parameter} ${h.previous} → ${h.current} (${h.change_percent}%)`).join('; ')}
            {r.delta_reviewed_at ? <Badge tone="green">Reviewed by {r.delta_reviewed_by}</Badge>
              : verify && <Button size="xs" variant="warning" onClick={onReview}>Review delta</Button>}
          </div>
        )}
        {reflex.length > 0 && (
          <div className="space-y-1 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200">
            {reflex.map((s) => (
              <div key={s.rule_id} className="flex flex-wrap items-center gap-2">
                <span><b>Reflex:</b> {s.test} — {s.reason}{s.comment && ` · ${s.comment}`}</span>
                {verify && <>
                  <Button size="xs" variant="primary" loading={act.isPending} onClick={() => act.mutate({ rule_id: s.rule_id, action: 'order' })}>Order {s.test}</Button>
                  <Button size="xs" variant="ghost" onClick={() => act.mutate({ rule_id: s.rule_id, action: 'dismiss' })}>Dismiss</Button>
                </>}
              </div>
            ))}
          </div>
        )}
        {(r.reflex_suggestions ?? []).filter((x) => x.status === 'Ordered').map((s) => (
          <p key={s.rule_id} className="text-xs text-ink-2">Reflex {s.test} ordered ({s.order_code}) — {s.reason}</p>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {!text && <Button size="xs" variant="ghost" icon="MessageSquarePlus" onClick={() => setText(true)}>Comments / impression</Button>}
          {d.dirty && <Button size="xs" variant="ghost" icon="Undo2" onClick={onReset}>Reset</Button>}
          {r.resulted_by && <span className="ml-auto text-xs text-ink-3">Entered by {r.resulted_by} · {dateTime(r.resulted_at)}</span>}
        </div>
        {text && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Textarea rows={2} value={d.result} disabled={!edit} placeholder="Comments / narrative report" aria-label="Comments"
              onChange={(e) => { const v = e.target.value; onPatch((x) => ({ ...x, result: v })) }} />
            <Textarea rows={2} value={d.impression} disabled={!edit} placeholder="Impression" aria-label="Impression"
              onChange={(e) => { const v = e.target.value; onPatch((x) => ({ ...x, impression: v })) }} />
          </div>
        )}
      </div>
    </article>
  )
}

function DeltaReview({ r, onClose }: { r: SheetRow; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => api(`/lab/worksheet/${r.id}/delta-review`, { method: 'POST', body: { note } }),
    onSuccess: () => { toast.success('Delta reviewed — the result can now be authorised'); qc.invalidateQueries({ queryKey: ['x', 'lab'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const fails = (r.delta_checks ?? []).filter((d) => d.failed)
  return (
    <Modal open onClose={onClose} title={`Delta check · ${r.test.name} · ${r.patient.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="warning" disabled={note.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Confirm review</Button></>}>
      {fails.length === 0 ? <p className="text-sm text-ink-2">Save the results first — delta checks run when results are saved.</p> : (
        <table className="mb-3 w-full text-sm">
          <thead className="text-xs text-ink-3"><tr><th className="text-left">Parameter</th><th className="text-right">Previous</th><th className="text-right">Now</th><th className="text-right">Change</th><th className="text-right">Limit</th></tr></thead>
          <tbody>{fails.map((d) => (
            <tr key={d.parameter} className="border-t border-line"><td className="py-1">{d.parameter}</td><td className="text-right tabular">{d.previous} <span className="text-[11px] text-ink-3">{date(d.previous_at)}</span></td>
              <td className="text-right tabular font-semibold">{d.current}</td><td className="text-right tabular text-red-700 dark:text-red-300">{d.change_percent}%</td><td className="text-right text-ink-2">{d.limit}</td></tr>
          ))}</tbody>
        </table>
      )}
      <FieldWrap label="Review note" required help="What was checked — clinical event, repeat sample, sample identity">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="e.g. Post-transfusion; confirmed with ward. Repeat on fresh sample matches." />
      </FieldWrap>
    </Modal>
  )
}

interface Matched { order_id: string; code: string; barcode: string; test: string; patient: string; values: Record<string, string> }

function ImportDialog({ onClose, onApply }: { onClose: () => void; onApply: (m: Matched[]) => void }) {
  const [text, setText] = useState('')
  const parse = useMutation({
    mutationFn: () => api<{ matched: Matched[]; unmatched: { line: string; reason: string }[]; lines: number }>('/lab/import', { method: 'POST', body: { text } }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const res = parse.data
  return (
    <Modal open onClose={onClose} size="lg" title="Import analyser output"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        {!res ? <Button variant="primary" disabled={text.trim().length < 3} loading={parse.isPending} onClick={() => parse.mutate()}>Match to tubes</Button>
          : <Button variant="primary" disabled={!res.matched.length} onClick={() => { onApply(res.matched); onClose() }}>Fill {res.matched.length} test{res.matched.length === 1 ? '' : 's'} on the worksheet</Button>}
      </>}>
      {!res ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-2">Paste the analyser / middleware export: one result per line as <span className="font-mono">barcode, parameter, value</span> (comma, tab, pipe or semicolon). Values appear as <b>interface values</b> and fill empty result cells for review — nothing is saved until you save the worksheet.</p>
          <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder={'2610140001,Haemoglobin,12.4\n2610140001,Total WBC,7.8\n2610140001,Platelets,245'} />
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-2">{res.lines} line{res.lines === 1 ? '' : 's'} read · {res.matched.length} test{res.matched.length === 1 ? '' : 's'} matched · {res.unmatched.length} unmatched</p>
          {res.matched.map((m) => (
            <div key={m.order_id} className="rounded-lg border border-line p-2">
              <div className="font-medium text-ink">{m.test} · {m.patient} <span className="font-mono text-xs text-ink-3">{m.barcode}</span></div>
              <div className="text-xs text-ink-2">{Object.entries(m.values).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
            </div>
          ))}
          {res.unmatched.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {res.unmatched.slice(0, 20).map((u, i) => <div key={i}><span className="font-mono">{u.line}</span> — {u.reason}</div>)}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
