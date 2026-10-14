import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Search } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, cn, Empty, Input, Kbd, Modal, Select, Spinner } from '@/components/ui'
import { api, apiUrl } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { money } from '@/lib/format'
import type { Rec } from '@/lib/types'
import { MODE_LABEL, PAY_MODES, printUrl, type PatientInfo, type PayMode, type PrintFormat, type Row } from './api'

// ------------------------------------------------------------------ small pieces

export function Switch({ checked, onChange, disabled, label, size = 'md' }: {
  checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string; size?: 'sm' | 'md'
}) {
  const w = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9'
  const k = size === 'sm' ? 'size-3' : 'size-4'
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled || !onChange}
      onClick={() => onChange?.(!checked)}
      className={cn('relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60',
        w, checked ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-600')}>
      <span className={cn('inline-block translate-x-0.5 rounded-full bg-white shadow transition-transform', k, checked && (size === 'sm' ? 'translate-x-3.5' : 'translate-x-[18px]'))} />
    </button>
  )
}

export function Copyable({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return <span className="text-ink-3">—</span>
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span className="font-mono">{value}</span>
      <button type="button" aria-label={`Copy ${value}`} className="text-ink-3 hover:text-ink"
        onClick={() => { navigator.clipboard?.writeText(value).then(() => toast.success(`Copied ${value}`), () => undefined) }}>
        <Copy className="size-3" />
      </button>
    </span>
  )
}

export function CopyButton({ value }: { value?: string | null }) {
  if (!value) return null
  return (
    <button type="button" aria-label={`Copy ${value}`} className="text-ink-3 hover:text-ink"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(value).then(() => toast.success(`Copied ${value}`), () => undefined) }}>
      <Copy className="size-3" />
    </button>
  )
}

export function KeyHints({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
      {items.map(([k, label]) => <span key={k} className="inline-flex items-center gap-1"><Kbd>{k}</Kbd>{label}</span>)}
    </div>
  )
}

export function PatientAvatar({ p, size = 'md' }: { p: Pick<PatientInfo, 'name' | 'photo'>; size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'sm' ? 'size-8 text-[11px]' : size === 'lg' ? 'size-14 text-base' : 'size-10 text-xs'
  const initials = (p.name ?? '?').replace(/^(Mr|Mrs|Ms|Master|Baby|Dr)\.?\s+/i, '').split(/\s+/).slice(0, 2).map((x) => x[0]?.toUpperCase()).join('')
  if (p.photo) return <img src={apiUrl(`/files/${p.photo}`, undefined, true)} alt="" className={cn('shrink-0 rounded-full object-cover ring-1 ring-line', s)} />
  return <span className={cn('grid shrink-0 place-items-center rounded-full bg-brand-100 font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200', s)}>{initials}</span>
}

export const payerLabel = (r: { sponsor?: string | null; payer_type?: string | null }) => r.sponsor || (r.payer_type === 'Self' ? 'Self-pay' : r.payer_type) || 'Self-pay'

export function BalancePill({ balance }: { balance: number }) {
  if (balance > 0.009) return <Badge tone="red">Due {money(balance)}</Badge>
  if (balance < -0.009) return <Badge tone="blue">Adv {money(-balance)}</Badge>
  return <Badge tone="green">Settled</Badge>
}

// ------------------------------------------------------------------ admission picker (header)

export function AdmissionPicker({ value, label, onPick, tab = 'all', placeholder = 'Patient, UHID, IP no, mobile…' }: {
  value?: string; label?: string; onPick: (row: Row) => void; tab?: 'admitted' | 'all' | 'discharged'; placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const dq = useDebounced(q)
  const box = useRef<HTMLDivElement>(null)
  const list = useQuery({
    queryKey: ['x', 'billing', 'ipb', 'pick', tab, dq],
    queryFn: () => api<{ rows: Row[] }>('/ipbilling/admissions', { query: { tab, q: dq, limit: 8 } }),
    enabled: open,
  })
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => setHi(0), [dq])
  const rows = list.data?.rows ?? []
  const pick = (r: Row) => { onPick(r); setOpen(false); setQ('') }
  return (
    <div ref={box} className="relative w-full sm:w-80">
      {open ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="pl-8" aria-label="Find admission"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
              else if (e.key === 'Enter' && rows[hi]) { e.preventDefault(); pick(rows[hi]) }
            }} />
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-2 bg-surface px-3 text-left text-sm shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20">
          <span className={cn('truncate', !label && 'text-ink-3')}>{label || placeholder}</span>
          <ChevronDown className="size-4 text-ink-3" />
        </button>
      )}
      {open && (
        <div className="absolute right-0 z-30 mt-1 max-h-80 w-full min-w-80 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin" role="listbox">
          {list.isLoading && <div className="px-3 py-2 text-sm text-ink-3">Searching…</div>}
          {!list.isLoading && rows.length === 0 && <div className="px-3 py-2 text-sm text-ink-3">No admissions match</div>}
          {rows.map((r, i) => (
            <button key={r.id} type="button" role="option" aria-selected={i === hi} onMouseEnter={() => setHi(i)} onClick={() => pick(r)}
              className={cn('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm', i === hi && 'bg-surface-2', r.id === value && 'font-medium')}>
              <span className="min-w-0">
                <span className="block truncate text-ink">{r.ip_no} — {r.patient.name}</span>
                <span className="block truncate text-xs text-ink-3">{r.patient.uhid} · {[r.ward?.name, r.bed?.bed_no].filter(Boolean).join(' · ')} · {payerLabel(r)}</span>
              </span>
              <Badge tone={r.status === 'Discharged' ? 'gray' : r.status === 'Admitted' ? 'green' : 'amber'}>{r.status}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ service search (Alt+S)

export interface ServiceHit { id: string; code: string; name: string; rate: number; category: string; tax_percent?: number }
export interface ServiceSearchHandle { focus: () => void; clear: () => void }

export const ServiceSearch = forwardRef<ServiceSearchHandle, {
  value: ServiceHit | null; onChange: (s: ServiceHit | null) => void; category?: string; placeholder?: string; onEnter?: () => void
}>(function ServiceSearch({ value, onChange, category, placeholder = 'Search service…', onEnter }, ref) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const dq = useDebounced(q, 200)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => { input.current?.focus(); setOpen(true) }, clear: () => { setQ(''); onChange(null) } }), [onChange])
  const list = useQuery({
    queryKey: ['lookup', 'billing.services', 'ipb', dq, category],
    queryFn: () => api<Rec[]>('/lookup/billing/services', { query: { q: dq, limit: 12, f_status: 'Active', f_category: category } }),
    enabled: open,
    staleTime: 60_000,
  })
  const rows: ServiceHit[] = useMemo(() => (list.data ?? []).map((r) => ({
    id: r.id, code: r.code ?? '', name: r.name ?? r.title ?? r.code ?? '', rate: Number(r.rate ?? 0), category: r.category ?? '', tax_percent: r.tax_percent,
  })), [list.data])
  useEffect(() => setHi(0), [dq])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const pick = (s: ServiceHit) => { onChange(s); setQ(''); setOpen(false) }
  return (
    <div ref={box} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
      <Input ref={input} value={open ? q : value ? `${value.name}${value.code ? ` · ${value.code}` : ''}` : q} placeholder={placeholder} className="pl-8"
        aria-label="Search service" role="combobox" aria-expanded={open}
        onFocus={() => { setOpen(true); setQ('') }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); if (value) onChange(null) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, rows.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            if (open && rows[hi]) pick(rows[hi]); else if (value) onEnter?.()
          } else if (e.key === 'Escape') setOpen(false)
        }} />
      {open && (
        <div className="absolute z-30 mt-1 max-h-72 w-full min-w-72 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin" role="listbox">
          {list.isLoading && <div className="px-3 py-2 text-sm text-ink-3">Searching tariff…</div>}
          {!list.isLoading && rows.length === 0 && <div className="px-3 py-2 text-sm text-ink-3">No services match</div>}
          {rows.map((s, i) => (
            <button key={s.id} type="button" role="option" aria-selected={i === hi} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}
              className={cn('flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm', i === hi && 'bg-surface-2')}>
              <span className="min-w-0">
                <span className="block truncate text-ink">{s.name}</span>
                <span className="block truncate text-xs text-ink-3">{s.code} · {s.category}</span>
              </span>
              <span className="shrink-0 tabular-nums text-ink-2">{money(s.rate)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

// ------------------------------------------------------------------ split-mode payment lines

export interface PayLine { mode: PayMode; amount: string; reference: string }
export const newPayLine = (amount = ''): PayLine => ({ mode: 'CASH', amount, reference: '' })

export function PayLines({ lines, onChange, due, autoFocus }: { lines: PayLine[]; onChange: (l: PayLine[]) => void; due?: number; autoFocus?: boolean }) {
  const set = (i: number, patch: Partial<PayLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0)
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,110px)_minmax(0,1.3fr)_auto] items-end gap-2">
          <label className="min-w-0 text-xs font-medium text-ink-2">{i === 0 && <span className="mb-1 block">Mode</span>}
            <Select value={l.mode} onChange={(e) => set(i, { mode: e.target.value as PayMode })} aria-label="Payment mode">
              {PAY_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </Select>
          </label>
          <label className="min-w-0 text-xs font-medium text-ink-2">{i === 0 && <span className="mb-1 block">Amount (₹)</span>}
            <Input type="number" min={0} step="0.01" value={l.amount} autoFocus={autoFocus && i === 0} onChange={(e) => set(i, { amount: e.target.value })} className="text-right tabular-nums" aria-label="Amount" />
          </label>
          <label className="min-w-0 text-xs font-medium text-ink-2">{i === 0 && <span className="mb-1 block">Reference no.</span>}
            <Input value={l.mode === 'CASH' ? '' : l.reference} disabled={l.mode === 'CASH'} placeholder={l.mode === 'CASH' ? '— cash —' : 'Txn / UTR / cheque no.'}
              onChange={(e) => set(i, { reference: e.target.value })} aria-label="Reference number" />
          </label>
          {lines.length > 1 ? (
            <Button size="sm" variant="ghost" icon="X" aria-label="Remove mode" onClick={() => onChange(lines.filter((_, j) => j !== i))} />
          ) : <span className="w-8" />}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="xs" icon="Plus" onClick={() => onChange([...lines, newPayLine(due !== undefined ? String(Math.max(0, +(due - total).toFixed(2))) : '')])} disabled={lines.length >= 6}>Add mode</Button>
        {due !== undefined && lines.length > 1 && <span className="text-xs text-ink-2">Total {money(total)} of {money(due)}</span>}
      </div>
    </div>
  )
}

export function payLinesValid(lines: PayLine[]): string | null {
  if (!lines.some((l) => Number(l.amount) > 0)) return 'Enter an amount'
  const bad = lines.find((l) => Number(l.amount) > 0 && l.mode !== 'CASH' && !l.reference.trim())
  return bad ? `Enter the reference for the ${MODE_LABEL[bad.mode]} payment` : null
}

export const payLinesBody = (lines: PayLine[]) => lines.filter((l) => Number(l.amount) > 0)
  .map((l) => ({ mode: l.mode, amount: Number(l.amount), reference: l.mode === 'CASH' ? undefined : l.reference.trim() }))

// ------------------------------------------------------------------ print preview (new tab / download / print)

export function PrintPreview({ open, onClose, admissionId, format, title, letterhead = true, no }: {
  open: boolean; onClose: () => void; admissionId: string; format: PrintFormat; title: ReactNode; letterhead?: boolean; no?: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const src = printUrl(admissionId, format, { letterhead, no })
  useEffect(() => { if (open) setLoaded(false) }, [open, src])
  return (
    <Modal open={open} onClose={onClose} size="xl" title={
      <span className="flex flex-wrap items-center gap-3">
        <span>{title}</span>
        <span className="flex gap-1.5">
          <Button size="xs" icon="ExternalLink" onClick={() => window.open(src, '_blank', 'noopener')}>New tab</Button>
          <Button size="xs" icon="Download" onClick={() => { window.location.href = printUrl(admissionId, format, { letterhead, download: true, no }) }}>Download</Button>
          <Button size="xs" variant="primary" icon="Printer" disabled={!loaded} onClick={() => frame.current?.contentWindow?.print()}>Print</Button>
        </span>
      </span>
    }>
      <div className="relative -mx-5 -my-4 bg-slate-200 dark:bg-slate-800">
        {!loaded && <div className="absolute inset-0 grid place-items-center"><Spinner label="Preparing document…" /></div>}
        <iframe ref={frame} src={open ? src : undefined} title="Print preview" onLoad={() => setLoaded(true)} className="h-[68vh] w-full border-0 bg-white" />
      </div>
    </Modal>
  )
}

export function Saving({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'saving') return <span className="text-xs text-ink-3">Saving…</span>
  if (state === 'error') return <span className="text-xs text-red-600">Not saved — check the highlighted line</span>
  return <span className="inline-flex items-center gap-1 text-xs text-ink-3"><Check className="size-3" />Changes save automatically</span>
}

// ------------------------------------------------------------------ page visibility (roles & permissions matrix)

export type IpbPage = 'ip-billing' | 'discharge-desk' | 'payment-desk'

/** Strict role-based visibility: render a screen only when the billing module page is visible to the role. */
export function PageGuard({ page, children }: { page: IpbPage; children: ReactNode }) {
  const reg = useRegistry()
  if (!reg.meta) return <Spinner />
  if (!reg.canPage('billing', page)) return <Empty icon="Lock" title="This screen is not available for your role">Ask an administrator if you need access to IP billing.</Empty>
  return <>{children}</>
}
