import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { date, dateTime, money, todayISO } from '@/lib/format'
import { K, KIND_LABEL, MODE_LABEL, useBillMutation, WARD_CATEGORIES, type Bill, type Line, type PrintFormat } from './api'
import { newPayLine, PayLines, payLinesBody, payLinesValid, PrintPreview, Switch, type PayLine } from './ui'

interface MProps { open: boolean; onClose: () => void; b: Bill }

// ------------------------------------------------------------------ bill formats

const MAIN_FORMATS: { key: PrintFormat; title: string; desc: string }[] = [
  { key: 'summarised', title: 'Summarised Bill', desc: 'One line per billing head — the shortest answer to "what does this stay cost".' },
  { key: 'semi', title: 'Semi Summarised Bill', desc: 'Each head broken into its service categories, with no individual charge lines.' },
  { key: 'final', title: 'Final Bill', desc: 'Every charge line, settled against the patient — with the receipts collected.' },
  { key: 'nonmed_summary', title: 'Non Medical Bill Summary (For Patient Use only)', desc: 'Services and stay charges only, totalled per head. GST inclusive.' },
  { key: 'nonmed', title: 'Non Medical Bill (For Patient Use only)', desc: 'Services and stay charges, line by line. No medicines or consumables.' },
  { key: 'pharmacy', title: 'Pharmacy Bill', desc: "The pharmacy's own bill of supply — every issue and return with batch and expiry." },
]
const SPONSOR_FORMATS: { key: PrintFormat; title: string; desc: string }[] = [
  { key: 'sponsor_tpa', title: 'Insurance / TPA Bill', desc: "Head-wise, with policy, pre-auth, co-pay and the insurer's share." },
  { key: 'sponsor_corporate', title: 'Corporate Bill', desc: "Credit bill to the organisation at its tariff, with the employee's share." },
  { key: 'sponsor_govt', title: 'Government Scheme Bill', desc: 'Scheme claim statement with beneficiary details and package codes.' },
  { key: 'detailed_gst', title: 'Detailed Bill with GST', desc: 'Every line with SAC / HSN, taxable value and CGST / SGST.' },
]

export function FormatsModal({ open, onClose, b }: MProps) {
  const [letterhead, setLetterhead] = useState(true)
  const [others, setOthers] = useState(b.sponsor.payer_type !== 'Self')
  const [fmt, setFmt] = useState<{ key: PrintFormat; title: string } | null>(null)
  const stay = b.sponsor.payer_type === 'Self' ? 'Self-pay stay' : `${b.sponsor.payer_type} stay`
  const Row = ({ f }: { f: { key: PrintFormat; title: string; desc: string } }) => (
    <button type="button" onClick={() => setFmt(f)} className="flex w-full items-start gap-3 rounded-lg border border-line px-3 py-2 text-left hover:border-brand-600/40 hover:bg-surface-2">
      <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span className="min-w-0"><span className="block text-sm font-medium text-ink">{f.title}</span><span className="block text-xs text-ink-2">{f.desc}</span></span>
    </button>
  )
  return (
    <>
      <Modal open={open && !fmt} onClose={onClose} title="Approximate bill formats" size="md">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
            <span className="flex items-center gap-2 text-xs text-ink-2">Letterhead
              <Segmented value={letterhead ? 'with' : 'without'} onChange={(v) => setLetterhead(v === 'with')} options={[{ key: 'with', label: 'With header' }, { key: 'without', label: 'Without header' }]} />
            </span>
            <span className="text-xs text-ink-3">{stay}</span>
          </div>
          <Row f={{ key: 'interim', title: 'Interim Receipt', desc: 'Advances and payments received so far against the running bill.' }} />
          {MAIN_FORMATS.map((f) => <Row key={f.key} f={f} />)}
          <button type="button" className="flex items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink" onClick={() => setOthers(!others)} aria-expanded={others}>
            <ChevronRight className={cn('size-3.5 transition-transform', others && 'rotate-90')} />Other formats ({SPONSOR_FORMATS.length}) — normally used for sponsored stays
          </button>
          {others && SPONSOR_FORMATS.map((f) => <Row key={f.key} f={f} />)}
        </div>
      </Modal>
      {fmt && <PrintPreview open onClose={() => setFmt(null)} admissionId={b.admission.id} format={fmt.key} letterhead={letterhead} title={`${fmt.title} · ${b.patient.name}`} />}
    </>
  )
}

// ------------------------------------------------------------------ change sponsor

interface SponsorRow { id: string; code: string; name: string; payer_type: string; discount_percent: number | null; co_pay_percent: number | null; tariff: { name: string; basis: string; percent: number } | null }
interface HeadStatus { head: string; lines: number; converted: number; unchanged: number; skipped: number; before: number; after: number; status: string }

export function SponsorModal({ open, onClose, b }: MProps) {
  const [mode, setMode] = useState<'prices' | 'organisation'>('prices')
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [pick, setPick] = useState<SponsorRow | 'self' | null>(null)
  const [approved, setApproved] = useState('')
  const [copay, setCopay] = useState('')
  const [credit, setCredit] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setPick(null); setQ(''); setMode('prices'); setApproved(''); setCopay(''); setCredit(''); setReason('') } }, [open])
  const list = useQuery({ queryKey: [...K.all, 'sponsors', dq], queryFn: () => api<SponsorRow[]>('/ipbilling/sponsors', { query: { q: dq || undefined } }), enabled: open })
  const sponsorId = pick === 'self' ? null : pick?.id
  const preview = useQuery({
    queryKey: [...K.all, 'sponsor-preview', b.admission.id, sponsorId ?? 'self'],
    queryFn: () => api<{ heads: HeadStatus[]; tariff: { name: string } | null }>(`/ipbilling/admissions/${b.admission.id}/sponsor/preview`, { method: 'POST', body: { sponsor_id: sponsorId } }),
    enabled: open && pick !== null,
  })
  const [result, setResult] = useState<HeadStatus[] | null>(null)
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/sponsor`, {
    method: 'POST', body: {
      sponsor_id: sponsorId, mode, reason: reason || undefined,
      ...(mode === 'organisation' && sponsorId ? { approved_amount: approved ? Number(approved) : undefined, co_pay_percent: copay ? Number(copay) : undefined, credit_ref: credit || undefined } : {}),
    },
  }), { success: (r) => `Converted — ${(r as { repriced: number }).repriced} line(s) re-priced`, onDone: (r) => setResult((r as { heads: HeadStatus[] }).heads) })
  const heads = result ?? preview.data?.heads
  const current = b.sponsor.sponsor_name ?? 'Self-pay'
  return (
    <Modal open={open} onClose={() => { setResult(null); onClose() }} title="Change Sponsor" size="lg"
      footer={result ? <Button variant="primary" onClick={() => { setResult(null); onClose() }}>Done</Button> : <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="RefreshCw" disabled={pick === null} loading={m.isPending} onClick={() => m.mutate()}>Convert</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-2">
          <span>Admission No: <b className="text-emerald-700 dark:text-emerald-400">{b.admission.ip_no}</b></span>
          <span>Patient Name: <b className="text-emerald-700 dark:text-emerald-400">{b.patient.name}</b></span>
          <span>Organisation: <b className="text-emerald-700 dark:text-emerald-400">{current}</b></span>
        </div>
        <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Conversion">
          {([['prices', 'Change prices only'], ['organisation', 'Change organisation + prices']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="radio" name="sp-mode" className="accent-brand-700" checked={mode === k} onChange={() => setMode(k)} />{l}</label>
          ))}
        </div>
        <FieldWrap label={<>Organisation / sponsor <span className="font-normal text-ink-3">{mode === 'prices' ? '(prices from this tariff; payer unchanged)' : '(payer and prices change)'}</span></>}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search organisation / sponsor…" aria-label="Search sponsor" />
        </FieldWrap>
        <div className="max-h-44 overflow-y-auto rounded-lg border border-line scroll-thin">
          <button type="button" onClick={() => setPick('self')} className={cn('flex w-full items-center justify-between border-b border-line px-3 py-1.5 text-left hover:bg-surface-2', pick === 'self' && 'bg-brand-50 dark:bg-brand-500/10')}>
            <span>Self-pay <span className="text-xs text-ink-3">· hospital tariff</span></span>
          </button>
          {list.isLoading && <Spinner />}
          {list.data?.map((s) => (
            <button key={s.id} type="button" onClick={() => { setPick(s); setCopay(s.co_pay_percent != null ? String(s.co_pay_percent) : '') }}
              className={cn('flex w-full items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-left last:border-0 hover:bg-surface-2', pick !== 'self' && pick?.id === s.id && 'bg-brand-50 dark:bg-brand-500/10')}>
              <span className="min-w-0"><span className="block truncate">{s.name}</span><span className="block truncate text-xs text-ink-3">{s.payer_type} · {s.tariff ? `${s.tariff.name} (${s.tariff.basis}${s.tariff.percent ? `, ${s.tariff.percent}%` : ''})` : s.discount_percent ? `Agreed discount ${s.discount_percent}%` : 'Hospital tariff'}</span></span>
              <span className="text-xs text-ink-3">{s.code}</span>
            </button>
          ))}
          {list.data?.length === 0 && <p className="px-3 py-2 text-xs text-ink-3">No sponsors match — add payers in Insurance / TPA.</p>}
        </div>
        {mode === 'organisation' && pick && pick !== 'self' && (
          <div className="grid gap-2 sm:grid-cols-3">
            <FieldWrap label="Approved amount (₹)"><Input type="number" min={0} value={approved} onChange={(e) => setApproved(e.target.value)} /></FieldWrap>
            <FieldWrap label="Patient co-pay %"><Input type="number" min={0} max={100} value={copay} onChange={(e) => setCopay(e.target.value)} /></FieldWrap>
            <FieldWrap label="Credit letter / pre-auth no."><Input value={credit} onChange={(e) => setCredit(e.target.value)} /></FieldWrap>
          </div>
        )}
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-xs text-emerald-700 dark:text-emerald-400"><th className="py-1.5 text-left font-semibold">Billing head</th><th className="text-right font-semibold">Lines</th><th className="text-right font-semibold">Current</th><th className="text-right font-semibold">After</th><th className="text-right font-semibold">Status</th></tr></thead>
          <tbody>
            {pick === null && <tr><td colSpan={5} className="py-3 text-center text-xs text-ink-3">Pick a sponsor to see the conversion per billing head</td></tr>}
            {preview.isLoading && <tr><td colSpan={5}><Spinner /></td></tr>}
            {preview.error && <tr><td colSpan={5}><ErrorBox error={preview.error} /></td></tr>}
            {pick !== null && heads?.map((h) => (
              <tr key={h.head} className="border-b border-line last:border-0">
                <td className="py-1.5 font-medium">{h.head}</td><td className="text-right tabular-nums">{h.lines}</td>
                <td className="text-right tabular-nums">{money(h.before)}</td><td className="text-right tabular-nums">{money(h.after)}</td>
                <td className="text-right"><Badge tone={h.status === 'Converted' ? 'green' : h.status === 'No change' ? 'gray' : 'amber'}>{result ? h.status : `${h.status === 'Converted' || h.status === 'Partly converted' ? 'Will convert' : h.status}`}{h.skipped ? ` · ${h.skipped} manual` : ''}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!result && <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded in the audit trail) — e.g. credit letter received" aria-label="Reason" />}
        <p className="text-xs text-ink-3">Manually priced, covered-by-package lines keep their price; billed lines are never changed.</p>
      </div>
    </Modal>
  )
}

export function TermsModal({ open, onClose, b }: MProps) {
  const s = b.sponsor
  const [approved, setApproved] = useState('')
  const [copay, setCopay] = useState('')
  const [credit, setCredit] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) { setApproved(s.approved_amount != null ? String(s.approved_amount) : ''); setCopay(String(s.co_pay_percent ?? 0)); setCredit(s.credit_ref ?? ''); setReason('') }
  }, [open, s.approved_amount, s.co_pay_percent, s.credit_ref])
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/sponsor-terms`, {
    method: 'PUT', body: { approved_amount: approved === '' ? null : Number(approved), co_pay_percent: Number(copay || 0), credit_ref: credit || null, reason: reason || undefined },
  }), { success: 'Sponsor terms updated', onDone: onClose })
  return (
    <Modal open={open} onClose={onClose} title={`Sponsor terms · ${s.sponsor_name ?? s.payer_type}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Sponsor approved amount (₹)" help={s.approved_source ? `Currently from: ${s.approved_source}` : 'From the credit letter / pre-authorisation'}><Input type="number" min={0} value={approved} onChange={(e) => setApproved(e.target.value)} autoFocus /></FieldWrap>
        <FieldWrap label="Patient co-pay %"><Input type="number" min={0} max={100} value={copay} onChange={(e) => setCopay(e.target.value)} /></FieldWrap>
        <FieldWrap label="Credit letter / pre-auth no."><Input value={credit} onChange={(e) => setCredit(e.target.value)} /></FieldWrap>
        <FieldWrap label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Enhancement approved by TPA" /></FieldWrap>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ change ward (billing category)

export function WardModal({ open, onClose, b }: MProps) {
  const [cat, setCat] = useState(b.ward_category ?? 'General')
  const [from, setFrom] = useState(todayISO())
  const [rate, setRate] = useState('')
  const [reprice, setReprice] = useState(true)
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setCat(b.ward_category ?? 'General'); setFrom(todayISO()); setRate(''); setReason('') } }, [open, b.ward_category])
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/ward`, {
    method: 'POST', body: { category: cat, from_date: from, room_rate: rate ? Number(rate) : undefined, reprice_services: reprice, reason: reason || undefined },
  }), { success: (r) => { const x = r as { changed: number; delta: number }; return `Re-priced ${x.changed} line(s) · ${x.delta >= 0 ? '+' : ''}${money(x.delta)}` }, onDone: onClose })
  return (
    <Modal open={open} onClose={onClose} title="Change ward (billing category)" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Re-price from {date(from)}</Button></>}>
      <div className="space-y-3">
        <p className="text-xs text-ink-2">Room rent, nursing and ward-specific service rates are re-priced from the change date. A physical bed move is a transfer on the bed board; billing follows it automatically.</p>
        <div className="grid grid-cols-2 gap-2">
          <FieldWrap label="Bill as"><Select value={cat} onChange={(e) => setCat(e.target.value)}>{WARD_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></FieldWrap>
          <FieldWrap label="From date"><Input type="date" value={from} min={b.admission.admitted_at?.slice(0, 10)} max={todayISO()} onChange={(e) => setFrom(e.target.value)} /></FieldWrap>
        </div>
        <FieldWrap label="Room rent per day (₹)" help="Leave empty to use the category rate (sponsor room rate when the tariff has one)."><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></FieldWrap>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-700" checked={reprice} onChange={(e) => setReprice(e.target.checked)} />Also re-price services with ward-specific rates (private / ICU rates)</label>
        <FieldWrap label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Upgrade on patient request" /></FieldWrap>
        {b.ward_changes.length > 0 && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
            <div className="mb-1 font-medium text-ink">History</div>
            {b.ward_changes.map((w, i) => <div key={i}>{date(w.from_date)} → {w.category ?? 'bed category'} · {w.source}{w.by ? ` · ${w.by}` : ''}{w.lines ? ` · ${w.lines} line(s)` : ''}</div>)}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ receipts (split modes) & refunds

export function ReceiptModal({ open, onClose, b }: MProps) {
  const qc = useQueryClient()
  const due = Math.max(0, b.position.balance)
  const [lines, setLines] = useState<PayLine[]>([newPayLine()])
  const [remarks, setRemarks] = useState('')
  useEffect(() => { if (open) { setLines([newPayLine(due ? String(due) : '')]); setRemarks('') } }, [open, due])
  const m = useMutation({
    mutationFn: () => api<{ receipts: { code: string; amount: number }[] }>(`/ipbilling/admissions/${b.admission.id}/receipts`, {
      method: 'POST', body: { lines: payLinesBody(lines), remarks: remarks || undefined, purpose: 'advance' },
    }),
    onSuccess: (r) => { toast.success(`Receipt ${r.receipts.map((x) => x.code).join(', ')} · ${money(r.receipts.reduce((s, x) => s + x.amount, 0))}`); qc.invalidateQueries({ queryKey: K.all }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const err = payLinesValid(lines)
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0)
  return (
    <Modal open={open} onClose={onClose} title="Advance / receipt" size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="success" icon="Wallet" disabled={!!err} loading={m.isPending} onClick={() => m.mutate()}>Collect {money(total)}</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-surface-2 px-2 py-2"><div className="text-ink-3">Patient share</div><div className="font-semibold tabular-nums">{money(b.position.patient_payable)}</div></div>
          <div className="rounded-lg bg-surface-2 px-2 py-2"><div className="text-ink-3">Paid incl. advance</div><div className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{money(b.position.paid)}</div></div>
          <div className="rounded-lg bg-amber-50 px-2 py-2 dark:bg-amber-500/10"><div className="text-ink-3">Balance</div><div className="font-semibold tabular-nums text-amber-700 dark:text-amber-300">{money(due)}</div></div>
        </div>
        {due > 0 && (
          <div className="flex gap-1.5">
            <Button size="xs" onClick={() => setLines([{ ...lines[0], amount: String(due) }])}>Full due</Button>
            <Button size="xs" onClick={() => setLines([{ ...lines[0], amount: String(Math.round(due / 2 * 100) / 100) }])}>Half</Button>
          </div>
        )}
        <PayLines lines={lines} onChange={setLines} due={due || undefined} autoFocus />
        <FieldWrap label="Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional — printed on the receipt" /></FieldWrap>
        <p className="text-xs text-ink-3">{b.permissions.closed ? 'Collected against the outstanding bill.' : 'Held as an advance for this admission and adjusted against the final bill at discharge.'} Cash of ₹2,00,000 or more per day from one person is refused (s.269ST).</p>
      </div>
    </Modal>
  )
}

export function RefundModal({ open, onClose, b }: MProps) {
  const qc = useQueryClient()
  const surplus = Math.max(0, -b.position.balance)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('CASH')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setAmount(surplus ? String(surplus) : ''); setReason('') } }, [open, surplus])
  const m = useMutation({
    mutationFn: () => api<{ refund: { code: string; status: string }; approval?: { code: string } | null }>(`/ipbilling/admissions/${b.admission.id}/refund`, {
      method: 'POST', body: { amount: Number(amount), mode, reason },
    }),
    onSuccess: (r) => { toast.success(r.approval ? `Refund ${r.refund.code} sent for approval` : `Refund ${r.refund.code} completed`); qc.invalidateQueries({ queryKey: K.all }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Refund advance" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!Number(amount) || reason.trim().length < 3 || Number(amount) > surplus + 0.001} loading={m.isPending} onClick={() => m.mutate()}>Refund {money(Number(amount || 0))}</Button></>}>
      <div className="space-y-3">
        {surplus <= 0 ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">There is no surplus advance to refund — the patient's share is not fully covered yet.</p>
          : <p className="text-sm text-ink-2">Surplus advance available: <b>{money(surplus)}</b></p>}
        <div className="grid grid-cols-2 gap-2">
          <FieldWrap label="Amount (₹)"><Input type="number" min={0} max={surplus} value={amount} onChange={(e) => setAmount(e.target.value)} /></FieldWrap>
          <FieldWrap label="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value)}>{['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE'].map((x) => <option key={x} value={x}>{MODE_LABEL[x]}</option>)}</Select></FieldWrap>
        </div>
        <FieldWrap label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></FieldWrap>
        <p className="text-xs text-ink-3">Refunds above the configured limit go to management for approval.</p>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ GST posting, no-show, admin charges

export function GstModal({ open, onClose, b }: MProps) {
  const prev = useQuery({
    queryKey: [...K.all, 'gst', b.admission.id],
    queryFn: () => api<{ changes: { id: string; name: string; date: string; head: string; taxable: number; old_percent: number; new_percent: number; gst_change: number; hsn_sac: string }[]; posted_at: string | null; rule: string }>(`/ipbilling/admissions/${b.admission.id}/gst`),
    enabled: open,
  })
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/gst`, { method: 'POST' }), {
    success: (r) => `GST posted on ${(r as { updated: number }).updated} line(s)`, onDone: onClose,
  })
  const ch = prev.data?.changes ?? []
  return (
    <Modal open={open} onClose={onClose} title="GST posting" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={!ch.length} loading={m.isPending} onClick={() => m.mutate()}>Post GST on {ch.length} line(s)</Button></>}>
      {prev.isLoading ? <Spinner /> : prev.error ? <ErrorBox error={prev.error} /> : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-ink-2">{prev.data?.rule}{prev.data?.posted_at ? ` Last posted ${dateTime(prev.data.posted_at)}.` : ''}</p>
          {!ch.length ? <Empty icon="CheckCircle2" title="GST is already correct on every line" /> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b border-line text-ink-2"><th className="py-1 text-left">Date</th><th className="text-left">Line</th><th className="text-left">SAC</th><th className="text-right">Taxable</th><th className="text-right">GST %</th><th className="text-right">GST change</th></tr></thead>
              <tbody>{ch.map((c) => <tr key={c.id} className="border-b border-line"><td className="py-1">{date(c.date)}</td><td>{c.name}</td><td className="font-mono">{c.hsn_sac}</td><td className="text-right tabular-nums">{money(c.taxable)}</td><td className="text-right tabular-nums">{c.old_percent} → {c.new_percent}</td><td className="text-right tabular-nums">{money(c.gst_change)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  )
}

export function NoShowModal({ open, onClose, b }: MProps) {
  const items = useQuery({
    queryKey: [...K.all, 'noshow', b.admission.id],
    queryFn: () => api<{ id: string; name: string; date: string; amount: number; order_code: string; order_status: string; category: string; ordered_at: string }[]>(`/ipbilling/admissions/${b.admission.id}/no-show`),
    enabled: open,
  })
  const [voiding, setVoiding] = useState<Line | null>(null)
  return (
    <Modal open={open} onClose={onClose} title="No-show items" size="lg">
      <p className="mb-3 text-xs text-ink-2">Services charged to the bill whose order was never collected or started (older than 12 hours). Void them so the patient is not billed for services not rendered.</p>
      {items.isLoading ? <Spinner /> : items.error ? <ErrorBox error={items.error} /> : !items.data?.length ? <Empty icon="CheckCircle2" title="No pending no-show items" /> : (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-xs text-ink-2"><th className="py-1 text-left">Ordered</th><th className="text-left">Service</th><th className="text-left">Order</th><th className="text-right">Amount</th><th /></tr></thead>
          <tbody>{items.data.map((x) => (
            <tr key={x.id} className="border-b border-line">
              <td className="py-1.5 text-xs">{dateTime(x.ordered_at)}</td><td>{x.name}</td><td className="text-xs"><span className="font-mono">{x.order_code}</span> <StatusBadge status={x.order_status} /></td>
              <td className="text-right tabular-nums">{money(x.amount)}</td>
              <td className="text-right"><Button size="xs" variant="ghost" className="text-red-600" onClick={() => setVoiding(b.lines.find((l) => l.id === x.id) ?? null)}>Void</Button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <VoidModal line={voiding} onClose={() => { setVoiding(null); items.refetch() }} b={b} defaultReason="Service not rendered (no-show)" />
    </Modal>
  )
}

export function VoidModal({ line, onClose, b, defaultReason = '' }: { line: Line | null; onClose: () => void; b: Bill; defaultReason?: string }) {
  const [reason, setReason] = useState(defaultReason)
  useEffect(() => { if (line) setReason(defaultReason) }, [line, defaultReason])
  const pkg = line?.kind === 'package'
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/${pkg ? `packages/${line!.id}/remove` : `lines/${line!.id}/void`}`, { method: 'POST', body: { reason } }), {
    success: pkg ? 'Package removed — its services are billed on top again' : 'Charge voided', onDone: onClose,
  })
  return (
    <Modal open={!!line} onClose={onClose} title={pkg ? 'Remove package' : 'Void charge'} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>{pkg ? 'Remove package' : 'Void charge'}</Button></>}>
      {line && <div className="space-y-3 text-sm">
        <p><b>{line.name}</b> · {date(line.date)} · {money(line.gross)}</p>
        <FieldWrap label="Reason (audited)" required><Textarea rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></FieldWrap>
      </div>}
    </Modal>
  )
}

export function AdminChargesModal({ open, onClose, b }: MProps) {
  const [mode, setMode] = useState<'percent' | 'amount'>('percent')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('Administration charges')
  const [reason, setReason] = useState('')
  const base = b.lines.filter((l) => l.status === 'Unbilled' && !l.covered && l.category !== 'PHARM' && l.source !== 'ipbilling.admin').reduce((s, l) => s + l.gross, 0)
  const amount = mode === 'percent' ? base * Number(value || 0) / 100 : Number(value || 0)
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/admin-charges`, {
    method: 'POST', body: { mode, value: Number(value), label, reason: reason || undefined },
  }), { success: 'Administration charges posted', onDone: onClose })
  return (
    <Modal open={open} onClose={onClose} title="Post administration charges" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!Number(value)} loading={m.isPending} onClick={() => m.mutate()}>Post {money(amount)}</Button></>}>
      <div className="space-y-3">
        <Segmented value={mode} onChange={setMode} options={[{ key: 'percent', label: '% of services' }, { key: 'amount', label: 'Fixed ₹' }]} />
        <FieldWrap label={mode === 'percent' ? `Percent of chargeable services (${money(base)})` : 'Amount (₹)'}><Input type="number" min={0} value={value} autoFocus onChange={(e) => setValue(e.target.value)} /></FieldWrap>
        <FieldWrap label="Line label"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></FieldWrap>
        <FieldWrap label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Hospital policy for IP stays" /></FieldWrap>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ breakdown / summary

export function BreakdownModal({ open, onClose, b }: MProps) {
  const heads = useMemo(() => {
    const m = new Map<string, { group: string; amount: number; discount: number; gst: number; covered: number; n: number }>()
    for (const l of b.lines) {
      const h = m.get(l.head) ?? { group: l.group, amount: 0, discount: 0, gst: 0, covered: 0, n: 0 }
      if (l.covered) h.covered += l.gross
      else { h.amount += l.gross; h.discount += l.discount; h.gst += l.gst }
      h.n += 1
      m.set(l.head, h)
    }
    return [...m.entries()].sort((a, c) => c[1].amount - a[1].amount)
  }, [b.lines])
  const p = b.position
  return (
    <Modal open={open} onClose={onClose} title={`Bill breakdown · ${b.admission.ip_no}`} size="lg">
      <div className="space-y-4 text-sm">
        <table className="w-full">
          <thead><tr className="border-b border-line text-xs text-ink-2"><th className="py-1 text-left">Billing head</th><th className="text-right">Lines</th><th className="text-right">Charges</th><th className="text-right">Discount</th><th className="text-right">GST</th><th className="text-right">In package</th></tr></thead>
          <tbody>{heads.map(([h, x]) => (
            <tr key={h} className="border-b border-line"><td className="py-1.5">{h} <span className="text-xs text-ink-3">· {x.group.toLowerCase()}</span></td><td className="text-right tabular-nums">{x.n}</td>
              <td className="text-right tabular-nums">{money(x.amount)}</td><td className="text-right tabular-nums">{x.discount ? money(x.discount) : '—'}</td><td className="text-right tabular-nums">{x.gst ? money(x.gst) : '—'}</td><td className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{x.covered ? money(x.covered) : '—'}</td></tr>
          ))}</tbody>
        </table>
        <div className="grid gap-4 md:grid-cols-2">
          <dl className="space-y-1 rounded-lg bg-surface-2 p-3">
            {[['Gross charges', p.gross], ['Discounts', -p.discount], ['GST', p.gst], ['Net bill', p.net], ['Sponsor share', -p.sponsor_payable], ['Patient share', p.patient_payable], ['Paid (incl. advance)', -p.paid], [p.balance >= 0 ? 'Balance due' : 'Refundable', Math.abs(p.balance)]].map(([k, v]) => (
              <div key={k as string} className="flex justify-between"><dt className="text-ink-2">{k}</dt><dd className="font-medium tabular-nums">{money(v)}</dd></div>
            ))}
          </dl>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Receipts & adjustments</div>
            {!b.receipts.length ? <p className="text-xs text-ink-3">No receipts yet.</p> : (
              <ul className="max-h-48 space-y-1 overflow-y-auto text-xs scroll-thin">
                {b.receipts.map((r) => (
                  <li key={r.id} className="flex justify-between gap-2"><span><span className="font-mono">{r.code}</span> · {KIND_LABEL[r.kind] ?? r.kind} · {MODE_LABEL[r.mode] ?? r.mode}{r.status !== 'Success' ? ` · ${r.status}` : ''}<span className="block text-ink-3">{dateTime(r.paid_at)}</span></span>
                    <span className={cn('tabular-nums', r.kind === 'REFUND' && 'text-red-600', r.status !== 'Success' && 'line-through text-ink-3')}>{r.kind === 'REFUND' ? '−' : ''}{money(r.amount)}</span></li>
                ))}
              </ul>
            )}
            {b.invoices.length > 0 && <div className="mt-2 text-xs text-ink-2">Bills: {b.invoices.map((i) => `${i.code} (${i.status})`).join(', ')}</div>}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ include / exclude (bulk)

export function IncludeModal({ open, onClose, b }: MProps) {
  const lines = b.lines.filter((l) => l.status === 'Unbilled' && l.kind !== 'package')
  const [sel, setSel] = useState<Record<string, boolean>>({})
  useEffect(() => { if (open) setSel(Object.fromEntries(lines.map((l) => [l.id, l.covered]))) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const hasPkg = b.packages.some((p) => p.status !== 'Billed')
  const changed = lines.filter((l) => sel[l.id] !== undefined && sel[l.id] !== l.covered)
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: async () => {
      let last: Bill | undefined
      for (const l of changed) last = await api<Bill>(`/ipbilling/admissions/${b.admission.id}/lines/${l.id}`, { method: 'PATCH', body: { in_package: sel[l.id] } })
      return last
    },
    onSuccess: (bill) => { if (bill) qc.setQueryData(K.bill(b.admission.id), bill); qc.invalidateQueries({ queryKey: K.all }); toast.success(`${changed.length} line(s) updated`); onClose() },
    onError: (e) => { toast.error(errorMessage(e)); qc.invalidateQueries({ queryKey: K.all }) },
  })
  return (
    <Modal open={open} onClose={onClose} title="Include / exclude from package" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!changed.length || !hasPkg} loading={m.isPending} onClick={() => m.mutate()}>Save {changed.length || ''} change(s)</Button></>}>
      {!hasPkg ? <Empty icon="Package" title="No package on this bill">Apply a package from the Package tab first.</Empty> : (
        <div className="max-h-[55vh] overflow-y-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-xs text-ink-2"><th className="py-1 text-left">Include</th><th className="text-left">Date</th><th className="text-left">Service</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id} className="border-b border-line">
                <td className="py-1.5"><Switch size="sm" checked={!!sel[l.id]} label={`Include ${l.name}`} onChange={(v) => setSel({ ...sel, [l.id]: v })} /></td>
                <td className="text-xs">{date(l.date)}</td><td>{l.name} <span className="text-xs text-ink-3">· {l.head}</span></td><td className="text-right tabular-nums">{money(l.gross)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ reopen, pre-auth estimate, cost estimate

export function ReopenModal({ open, onClose, b }: MProps) {
  const [reason, setReason] = useState('')
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/reopen`, { method: 'POST', body: { reason } }), {
    success: 'Reopen request sent to management for approval', onDone: onClose,
  })
  return (
    <Modal open={open} onClose={onClose} title={`Reopen IP bill · ${b.admission.ip_no}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="warning" disabled={reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate()}>Request approval</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-ink-2">After approval the final bill is cancelled and its lines return to the working bill. Money already received is kept as advance and adjusted again when you settle. Every step is in the audit trail.</p>
        <FieldWrap label="Reason" required><Textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. ECG on day 2 was not billed; sponsor approved amount revised" /></FieldWrap>
      </div>
    </Modal>
  )
}

export function PreauthModal({ open, onClose, b }: MProps) {
  const [los, setLos] = useState('')
  const [policy, setPolicy] = useState('')
  const [res, setRes] = useState<{ preauth: { code: string; status: string; requested_amount: number }; projected: number; remaining_days: number; breakup: { head: string; amount: number }[] } | null>(null)
  useEffect(() => { if (open) { setRes(null); setLos(''); setPolicy(b.sponsor.credit_ref ?? '') } }, [open, b.sponsor.credit_ref])
  const m = useMutation({
    mutationFn: () => api<NonNullable<typeof res>>(`/ipbilling/admissions/${b.admission.id}/preauth-estimate`, { method: 'POST', body: { expected_los: los ? Number(los) : undefined, policy_no: policy || undefined } }),
    onSuccess: (r) => { setRes(r); toast.success(`Pre-authorisation ${r.preauth.code} · ${money(r.projected)}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Corporate approximate (pre-auth estimate)" size="md"
      footer={res ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Create estimate</Button></>}>
      {res ? (
        <div className="space-y-2 text-sm">
          <p>Pre-authorisation <b className="font-mono">{res.preauth.code}</b> ({res.preauth.status}) requests <b>{money(res.projected)}</b> from {b.sponsor.sponsor_name}. Submit it from Insurance / TPA.</p>
          <ul className="space-y-0.5 text-xs">{res.breakup.map((x) => <li key={x.head} className="flex justify-between"><span>{x.head}</span><span className="tabular-nums">{money(x.amount)}</span></li>)}</ul>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">Projects the stay from today's working bill plus the remaining expected days at the current room and nursing rates, and raises (or updates) a draft pre-authorisation for <b>{b.sponsor.sponsor_name ?? b.sponsor.payer_type}</b>.</p>
          <div className="grid grid-cols-2 gap-2">
            <FieldWrap label="Expected length of stay (days)"><Input type="number" min={0} value={los} onChange={(e) => setLos(e.target.value)} placeholder="From admission" /></FieldWrap>
            <FieldWrap label="Policy / card / employee no."><Input value={policy} onChange={(e) => setPolicy(e.target.value)} /></FieldWrap>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function CostEstimateModal({ open, onClose, b }: MProps) {
  const [los, setLos] = useState('')
  const [deposit, setDeposit] = useState('')
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => api<{ estimate: { code: string }; projected: number }>(`/ipbilling/admissions/${b.admission.id}/cost-estimate`, { method: 'POST', body: { expected_los: los ? Number(los) : undefined, deposit_amount: deposit ? Number(deposit) : undefined } }),
    onSuccess: (r) => { toast.success(`Estimate ${r.estimate.code} saved · ${money(r.projected)}`); qc.invalidateQueries({ queryKey: K.all }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Package approximate billing — save as cost estimate" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save estimate</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-2">Saves the projected bill (head-wise) in Financial Counselling. Estimate vs actual closes automatically when this bill settles.</p>
        <div className="grid grid-cols-2 gap-2">
          <FieldWrap label="Expected stay (days)"><Input type="number" min={0} value={los} onChange={(e) => setLos(e.target.value)} placeholder="From admission" /></FieldWrap>
          <FieldWrap label="Deposit to ask (₹)"><Input type="number" min={0} value={deposit} onChange={(e) => setDeposit(e.target.value)} /></FieldWrap>
        </div>
      </div>
    </Modal>
  )
}
