import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Lock, Printer, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RecordDrawer, useEntity } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, apiUrl, errorMessage } from '@/lib/api'
import { date, dateTime, number } from '@/lib/format'
import type { BespokeProps } from './index'

interface SignRef { id: string; code: string; status: string }
interface RegisterMeta {
  key: string; name: string; class: string; legal_basis: string; authority: string; frequency: string; source: string
  columns: { key: string; label: string }[]; available: boolean; can_view?: boolean; signoffs?: Record<string, SignRef | null>
}
interface RegisterList { registers: RegisterMeta[]; can_sign: boolean }
interface RegisterData {
  register: RegisterMeta; from: string; to: string; count: number; rows: Record<string, string | number | null>[]; period: string | null
  signoff: { id: string; code: string; status: string; entries_count?: number; discrepancies?: number; signed_at?: string | null } | null
  hospital: string; generated_at: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const thisMonth = () => ym(new Date())
const lastMonth = () => { const d = new Date(); d.setDate(0); return ym(d) }
const todayLocal = () => { const d = new Date(); return `${ym(d)}-${pad(d.getDate())}` }
const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  .register-print, .register-print * { visibility: visible !important; }
  .register-print { position: absolute; inset: 0 auto auto 0; width: 100%; }
  .register-print table { font-size: 9px; }
  @page { size: A4 landscape; margin: 10mm; }
}`

function SignoffModal({ reg, period, open, onClose, onDone }: { reg: RegisterMeta; period: string; open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [disc, setDisc] = useState(0)
  const [notes, setNotes] = useState('')
  const save = useMutation({
    mutationFn: () => api<{ id: string; code: string; entries_count: number }>(`/registers/${reg.key}/signoff`, {
      method: 'POST', body: { period, discrepancies: disc, discrepancy_notes: notes || undefined },
    }),
    onSuccess: (r) => { toast.success(`${r.code}: ${r.entries_count} entries frozen for sign-off`); onDone(r.id) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title={`Sign-off · ${reg.name} · ${period}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Prepare sign-off</Button></>}>
      <p className="mb-3 text-sm text-ink-2">The register is regenerated from live records and the entry count is recorded. You then sign it with your signature in the
        next step. Corrections never edit the register — raise a register correction against the source record.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <FieldWrap label="Discrepancies found"><Input type="number" min={0} value={disc} onChange={(e) => setDisc(Math.max(0, Number(e.target.value) || 0))} /></FieldWrap>
        <FieldWrap label="Notes" className="sm:col-span-2"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 2 MLC entries without police intimation time" /></FieldWrap>
      </div>
    </Modal>
  )
}

export default function Registers(_: BespokeProps) {
  const qc = useQueryClient()
  const signEntity = useEntity('registers.signoffs')
  const list = useQuery({ queryKey: ['x', 'registers', 'list'], queryFn: () => api<RegisterList>('/registers') })
  const [key, setKey] = useState<string | null>(null)
  const [mode, setMode] = useState<'month' | 'range'>('month')
  const [month, setMonth] = useState(thisMonth)
  const [from, setFrom] = useState(() => `${thisMonth()}-01`)
  const [to, setTo] = useState(todayLocal)
  const [filter, setFilter] = useState('')
  const [signing, setSigning] = useState(false)
  const [openSign, setOpenSign] = useState<string | null>(null)
  const regs = list.data?.registers ?? []
  useEffect(() => { if (!key && regs.length) setKey((regs.find((r) => r.can_view) ?? regs[0]).key) }, [regs, key])
  const reg = regs.find((r) => r.key === key)
  const query = mode === 'month' ? { period: month } : { from, to }
  const data = useQuery({
    queryKey: ['x', 'registers', key, query],
    queryFn: () => api<RegisterData>(`/registers/${key}`, { query }),
    enabled: !!key && !!reg?.can_view,
    placeholderData: (p) => (p && p.register.key === key ? p : undefined),
  })
  const rows = useMemo(() => {
    const t = filter.trim().toLowerCase()
    const all = data.data?.rows ?? []
    return t ? all.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(t))) : all
  }, [data.data, filter])
  const d = data.data

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <style>{PRINT_CSS}</style>
      <Card pad={false} title="Registers" icon="BookOpen" className="no-print h-fit">
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
        <ul className="divide-y divide-line">
          {regs.map((r) => {
            const cur = r.signoffs?.[thisMonth()]
            const prev = r.signoffs?.[lastMonth()]
            return (
              <li key={r.key}>
                <button type="button" disabled={!r.can_view} onClick={() => setKey(r.key)}
                  className={cn('w-full px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50', key === r.key ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{r.name}</span>
                    {r.can_view ? <Badge tone={r.class === 'Statutory' ? 'violet' : 'cyan'}>{r.class}</Badge> : <Lock className="size-3.5 text-ink-3" aria-label="No access" />}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-ink-3">
                    <span>{lastMonth()}: {prev ? prev.status : 'not signed'}</span>·<span>{thisMonth()}: {cur ? cur.status : 'open'}</span>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </Card>

      <div className="min-w-0 space-y-3">
        {reg && (
          <div className="no-print flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <Segmented value={mode} onChange={setMode} options={[{ key: 'month', label: 'Month' }, { key: 'range', label: 'Date range' }]} />
            {mode === 'month' ? (
              <Input type="month" className="h-8 w-40" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
            ) : (
              <div className="flex items-center gap-1 text-xs text-ink-2">
                <Input type="date" className="h-8 w-36" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                <span>to</span>
                <Input type="date" className="h-8 w-36" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              </div>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
              <Input className="h-8 w-48 pl-8" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <a href={apiUrl(`/registers/${reg.key}.csv`, query, true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">
                <Download className="size-4" /> CSV
              </a>
              <Button size="sm" onClick={() => window.print()} disabled={!d}><Printer className="size-4" /> Print</Button>
              {list.data?.can_sign && mode === 'month' && (
                d?.signoff?.status === 'Signed'
                  ? <Button size="sm" variant="success" icon="BadgeCheck" onClick={() => setOpenSign(d.signoff!.id)}>Signed · {d.signoff.code}</Button>
                  : <Button size="sm" variant="primary" icon="PenLine" onClick={() => (d?.signoff ? setOpenSign(d.signoff.id) : setSigning(true))}>
                      {d?.signoff ? `Sign ${d.signoff.code}` : 'Sign off month'}
                    </Button>
              )}
            </div>
          </div>
        )}
        {!reg && !list.isLoading && <Empty icon="BookOpen" title="Choose a register" />}
        {reg && !reg.can_view && <Empty icon="Lock" title="No access">Your role cannot read the source records of this register.</Empty>}
        {data.error && <ErrorBox error={data.error} />}
        {data.isLoading && <Spinner label="Generating register from live data…" />}
        {d && reg?.can_view && (
          <section className="register-print rounded-xl border border-line bg-surface">
            <header className="border-b border-line px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-ink-3">{d.hospital}</p>
                  <h2 className="text-lg font-semibold text-ink">{d.register.name}</h2>
                  <p className="text-xs text-ink-2">{d.register.legal_basis} · submitted to {d.register.authority}</p>
                </div>
                <div className="text-right text-xs text-ink-2">
                  <div className="font-medium text-ink">{d.period ? `Period ${d.period}` : `${date(d.from)} – ${date(d.to)}`}</div>
                  <div>{number(d.count)} entries{filter && ` · ${rows.length} shown`}</div>
                  <div>Generated {dateTime(d.generated_at)}</div>
                  {d.signoff && <div className="mt-1"><StatusBadge status={d.signoff.status} /> {d.signoff.code}{d.signoff.signed_at ? ` · ${dateTime(d.signoff.signed_at)}` : ''}</div>}
                </div>
              </div>
            </header>
            {!rows.length ? <Empty icon="BookOpen" title={filter ? 'No rows match the filter' : 'No entries for this period'} /> : (
              <div className="max-h-[65vh] overflow-auto scroll-thin print:max-h-none print:overflow-visible">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-surface-2 text-ink-2">
                    <tr>
                      <th className="px-2 py-1.5 text-right font-medium">#</th>
                      {d.register.columns.map((c) => <th key={c.key} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="px-2 py-1 text-right tabular text-ink-3">{i + 1}</td>
                        {d.register.columns.map((c) => (
                          <td key={c.key} className={cn('px-2 py-1', ['description', 'address', 'critical_values', 'final_diagnosis', 'diagnosis'].includes(c.key) ? 'min-w-48' : 'whitespace-nowrap')}>
                            {r[c.key] === null || r[c.key] === undefined || r[c.key] === '' ? <span className="text-ink-3">—</span> : String(r[c.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <footer className="hidden border-t border-line px-4 py-6 text-xs print:flex print:justify-between">
              <span>Verified by: ______________________</span><span>Signature & date: ______________________</span>
            </footer>
          </section>
        )}
      </div>
      {reg && signing && (
        <SignoffModal reg={reg} period={month} open onClose={() => setSigning(false)}
          onDone={(id) => { setSigning(false); qc.invalidateQueries({ queryKey: ['x', 'registers'] }); setOpenSign(id) }} />
      )}
      {openSign && signEntity && (
        <RecordDrawer entity={signEntity} id={openSign} onClose={() => { setOpenSign(null); qc.invalidateQueries({ queryKey: ['x', 'registers'] }) }} />
      )}
    </div>
  )
}
