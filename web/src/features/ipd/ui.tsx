import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Badge, Button, cn, FieldWrap, Modal, Textarea } from '@/components/ui'
import { money } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { conditionTone, PAYER_TONE } from './api'

const TOP: Record<string, string> = {
  green: 'border-t-emerald-600', indigo: 'border-t-indigo-600', blue: 'border-t-sky-600', orange: 'border-t-orange-500',
  violet: 'border-t-violet-600', pink: 'border-t-pink-500', teal: 'border-t-teal-600', amber: 'border-t-amber-500', brand: 'border-t-brand-700',
}
const ICON_TONE: Record<string, string> = {
  green: 'text-emerald-700 dark:text-emerald-300', indigo: 'text-indigo-700 dark:text-indigo-300', blue: 'text-sky-700 dark:text-sky-300',
  orange: 'text-orange-600 dark:text-orange-300', violet: 'text-violet-700 dark:text-violet-300', pink: 'text-pink-600 dark:text-pink-300',
  teal: 'text-teal-700 dark:text-teal-300', amber: 'text-amber-600 dark:text-amber-300', brand: 'text-brand-700 dark:text-brand-300',
}

/** Card with a coloured top rule — the section style used across the IP screens. */
export function Section({ title, subtitle, icon, tone = 'brand', actions, children, className, pad = true, id }: {
  title: ReactNode; subtitle?: ReactNode; icon?: string; tone?: keyof typeof TOP; actions?: ReactNode; children: ReactNode
  className?: string; pad?: boolean; id?: string
}) {
  return (
    <section id={id} className={cn('rounded-xl border border-line border-t-[3px] bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]', TOP[tone], className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {icon && <Icon name={icon} className={cn('size-4', ICON_TONE[tone])} />}
            {title}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

export function ConditionPill({ condition, className }: { condition?: string | null; className?: string }) {
  const c = condition || 'Not assessed'
  return <Badge tone={conditionTone(c)} dot className={className}>{c}</Badge>
}

export function PayerChip({ payer, label, sponsor }: { payer: string; label?: string; sponsor?: string | null }) {
  return (
    <Badge tone={PAYER_TONE[payer] ?? 'gray'}>
      {label ?? payer}{sponsor ? ` · ${sponsor}` : payer === 'Cash' ? ' · Self-pay' : ''}
    </Badge>
  )
}

export function PatientCell({ p, sub, to }: { p: { id: string; name: string; uhid: string; age?: number | null; gender?: string | null; phone?: string | null }; sub?: ReactNode; to?: string }) {
  const meta = [p.uhid, p.age != null ? `${p.age}y` : null, p.gender?.[0], p.phone].filter(Boolean).join(' · ')
  return (
    <div className="min-w-0">
      {to ? <Link to={to} className="block truncate font-medium text-ink hover:underline">{p.name}</Link> : <span className="block truncate font-medium text-ink">{p.name}</span>}
      <span className="block truncate text-xs text-ink-3">{sub ?? meta}</span>
    </div>
  )
}

/** Amount with Indian grouping; negative values (returns, advance) keep the sign. */
export function Amount({ v, className, tone }: { v?: number | null; className?: string; tone?: 'due' | 'paid' | 'adv' }) {
  if (v === null || v === undefined) return <span className="text-ink-3">—</span>
  const t = tone === 'due' ? 'text-red-700 dark:text-red-300' : tone === 'paid' ? 'text-emerald-700 dark:text-emerald-300' : tone === 'adv' ? 'text-sky-700 dark:text-sky-300' : ''
  return <span className={cn('tabular-nums', t, className)}>{money(v)}</span>
}

/** KPI tile that doubles as a list filter; the selected one is outlined. */
export function FilterTile({ label, value, icon, active, onClick, tone = 'brand', hint }: {
  label: string; value: ReactNode; icon: string; active?: boolean; onClick?: () => void; tone?: 'brand' | 'green' | 'amber' | 'navy' | 'red'; hint?: ReactNode
}) {
  const ic = { brand: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300', green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300', navy: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300',
    red: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' }[tone]
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex min-w-0 items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors',
        active ? 'border-brand-700 ring-1 ring-brand-700 dark:border-brand-400 dark:ring-brand-400' : 'border-line hover:border-brand-600/40 hover:bg-surface-2')}>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', ic)}><Icon name={icon} className="size-4.5" /></span>
      <span className="min-w-0">
        <span className="block text-xl font-semibold tabular-nums leading-tight text-ink">{value}</span>
        <span className="block truncate text-xs text-ink-2">{label}</span>
        {hint && <span className="block truncate text-[11px] text-ink-3">{hint}</span>}
      </span>
    </button>
  )
}

/** Ask for a reason before a destructive action (void, cancel, revoke). */
export function ReasonDialog({ open, title, message, label = 'Reason', confirm = 'Confirm', tone = 'danger', busy, onClose, onConfirm, min = 3 }: {
  open: boolean; title: string; message?: ReactNode; label?: string; confirm?: string; tone?: 'danger' | 'primary'; busy?: boolean
  onClose: () => void; onConfirm: (reason: string) => void; min?: number
}) {
  const [reason, setReason] = useState('')
  const ok = reason.trim().length >= min
  return (
    <Modal open={open} onClose={() => { setReason(''); onClose() }} title={title} size="sm"
      footer={<>
        <Button variant="ghost" onClick={() => { setReason(''); onClose() }}>Cancel</Button>
        <Button variant={tone} disabled={!ok} loading={busy} onClick={() => onConfirm(reason.trim())}>{confirm}</Button>
      </>}>
      {message && <div className="mb-3 text-sm text-ink-2">{message}</div>}
      <FieldWrap label={label} required help="Recorded in the audit trail with your name and the time">
        <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok) onConfirm(reason.trim()) }} />
      </FieldWrap>
    </Modal>
  )
}

export function StageBadge({ stage, critical }: { stage: string; critical?: boolean }) {
  const tone = stage === 'Reported' ? 'green' : stage === 'Cancelled' ? 'gray' : stage === 'Ordered' ? 'blue' : 'amber'
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={tone} dot>{stage}</Badge>
      {critical && <Badge tone="red">Critical</Badge>}
    </span>
  )
}

/** Thin table shell with a sticky header. */
export function Table({ head, children, empty, className }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto scroll-thin', className)}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-[1] border-b border-line bg-surface-2 text-[11px] uppercase tracking-wide text-ink-3">
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 text-left font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  )
}

export const td = 'px-3 py-2 align-top'

export interface Opt { value: string; label: string; hint?: string; group?: string; disabled?: boolean }

/** Searchable select over a local option list (keyboard: type to filter, ↑ ↓ to move, Enter to pick). */
export function SearchSelect({ options, value, onChange, placeholder = 'Select…', disabled, invalid, id, autoFocus }: {
  options: Opt[]; value?: string | null; onChange: (v: string | null) => void; placeholder?: string; disabled?: boolean; invalid?: boolean
  id?: string; autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const cur = options.find((o) => o.value === value)
  const term = q.trim().toLowerCase()
  const shown = (term ? options.filter((o) => `${o.label} ${o.hint ?? ''} ${o.group ?? ''}`.toLowerCase().includes(term)) : options).slice(0, 80)
  const pick = (o?: Opt) => { if (o && !o.disabled) { onChange(o.value); setOpen(false); setQ('') } }
  return (
    <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <input id={id} autoFocus={autoFocus} disabled={disabled} role="combobox" aria-expanded={open} autoComplete="off"
        value={open ? q : cur?.label ?? ''} placeholder={cur ? cur.label : placeholder}
        onFocus={() => { setOpen(true); setHi(0) }} onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter' && open) { e.preventDefault(); pick(shown[hi]) }
          else if (e.key === 'Escape') setOpen(false)
        }}
        className={cn('h-9 w-full rounded-lg border border-line-2 bg-surface px-3 pr-8 text-sm text-ink placeholder:text-ink-3 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-surface-2',
          invalid && 'border-red-500')} />
      {value && !disabled && (
        <button type="button" tabIndex={-1} aria-label="Clear" onClick={() => onChange(null)} className="absolute right-2 top-2 text-ink-3 hover:text-ink">
          <Icon name="X" className="size-4" />
        </button>
      )}
      {open && !disabled && (
        <div className="absolute z-30 mt-1 max-h-72 w-full min-w-64 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
          {shown.length === 0 && <div className="px-3 py-2 text-sm text-ink-3">No matches</div>}
          {shown.map((o, i) => (
            <button type="button" key={o.value} tabIndex={-1} disabled={o.disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}
              onMouseEnter={() => setHi(i)}
              className={cn('flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-40',
                i === hi ? 'bg-surface-2' : '', o.value === value && 'font-medium text-brand-800 dark:text-brand-300')}>
              <span className="min-w-0">
                <span className="block truncate text-ink">{o.label}</span>
                {o.hint && <span className="block truncate text-xs text-ink-3">{o.hint}</span>}
              </span>
              {o.group && <span className="shrink-0 text-[11px] text-ink-3">{o.group}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Field configuration (W1) for a custom screen: hidden / required / label / default, with safe fallbacks. */
export interface FieldCfg { hidden?: boolean; visible?: boolean; required?: boolean; readonly?: boolean; label?: string | null; default?: unknown }
export function cfgOf(cfg: Record<string, FieldCfg> | undefined, key: string): { show: boolean; required: boolean; label?: string; def?: unknown; readonly: boolean } {
  const f = cfg?.[key]
  return { show: !(f?.hidden || f?.visible === false), required: !!f?.required, label: f?.label || undefined, def: f?.default, readonly: !!f?.readonly }
}
