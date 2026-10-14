import clsx, { type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { BookOpen, Check, Copy, Keyboard, Loader2, Maximize2, Minimize2, X } from 'lucide-react'
import {
  forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { openShortcutHelp, toggleFocus, useChrome } from '@/lib/chrome'
import { initials } from '@/lib/format'
import { Icon } from '@/lib/icons'

export const cn = (...v: ClassValue[]) => twMerge(clsx(v))

// ------------------------------------------------------------------ buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warning' | 'neutral'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm',
  secondary: 'bg-surface text-ink border border-line-2 hover:bg-surface-2 shadow-sm',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
  warning: 'bg-amber-500 text-white hover:bg-amber-600 shadow-sm',
  neutral: 'bg-slate-600 text-white hover:bg-slate-700 shadow-sm',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'xs' | 'sm' | 'md'
  icon?: string
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest }, ref,
) {
  const sz = size === 'xs' ? 'h-7 px-2 text-xs gap-1' : size === 'sm' ? 'h-8 px-3 text-sm gap-1.5' : 'h-9 px-4 text-sm gap-2'
  return (
    <button
      ref={ref}
      className={cn('inline-flex items-center justify-center rounded-lg font-medium transition-colors whitespace-nowrap',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50 disabled:pointer-events-none',
        VARIANTS[variant], sz, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon ? <Icon name={icon} className="size-4" /> : null}
      {children}
    </button>
  )
})

export function toneVariant(tone?: string): Variant {
  return tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : tone === 'neutral' ? 'secondary' : 'primary'
}

// ------------------------------------------------------------------ badges

export type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet' | 'cyan'
const BADGE: Record<BadgeTone, string> = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300',
  blue: 'bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300',
  gray: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-300',
  violet: 'bg-violet-50 text-violet-800 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300',
  cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-600/20 dark:bg-cyan-500/10 dark:text-cyan-300',
}

export function Badge({ tone = 'gray', children, className, dot }: { tone?: BadgeTone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', BADGE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

const GREEN = /^(completed|done|verified|approved|paid|active|signed|issued|discharged|vacant|available|present|posted|resolved|dispensed|online|published|valid|success|sent|delivered|received|converted|accepted|given|complete|fit|pass|closed won|settled|joined|merged)$/i
const AMBER = /^(awaiting activation|out for service|pending|requested|draft|waiting|ordered|booked|scheduled|applied|pending review|pending approval|pending verification|expiring|partially.*|reserved|cleaning|under review|query|on notice|raised|proposed|planned|offered|documents pending|held|maintenance|quarantine|enhancement requested|half day|observation|warning.*|shared|in queue|due)$/i
const RED = /^(out of service|lost|missing|cancelled|rejected|failed|expired|critical|blocked|no-show|absent|deceased|terminated|error|missed|refused|blacklisted|banned|reversed|overdue|withdrawn|disabled|lama|dama|sentinel.*|returned|fail.*)$/i
const BLUE = /^(in progress|checked-in|in consultation|called|serving|admitted|collected|resulted|processed|in treatment|occupied|submitted|open|discharge initiated|en route|assigned|in call|under inquiry|hearing|rca|capa|generated|in process|ongoing|investigating)$/i

export function statusTone(s?: string | null): BadgeTone {
  if (!s) return 'gray'
  if (GREEN.test(s)) return 'green'
  if (RED.test(s)) return 'red'
  if (AMBER.test(s)) return 'amber'
  if (BLUE.test(s)) return 'blue'
  return 'gray'
}

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-ink-3">—</span>
  return <Badge tone={statusTone(status)} dot>{status}</Badge>
}

// ------------------------------------------------------------------ surfaces

export function Card({ children, className, title, actions, icon, pad = true }: {
  children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; icon?: string; pad?: boolean
}) {
  return (
    <section className={cn('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {icon && <Icon name={icon} className="size-4 text-brand-700 dark:text-brand-400" />}
            {title}
          </h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

/**
 * Standard page header. Work screens get the focus (expand) toggle and the `?` shortcut help;
 * pass `guide` (a URL or a click handler) to show a "Guide" button. `chrome={false}` hides both icons.
 */
export function PageHeader({ title, subtitle, icon, actions, badge, guide, chrome = true }: {
  title: ReactNode; subtitle?: ReactNode; icon?: string; actions?: ReactNode; badge?: ReactNode
  guide?: string | (() => void); chrome?: boolean
}) {
  const { focus } = useChrome()
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-300">
            <Icon name={icon} className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
            {badge}
            {chrome && (
              <button type="button" onClick={toggleFocus} title={focus ? 'Exit focus mode (Shift+F)' : 'Focus mode — hide menus (Shift+F)'}
                aria-label={focus ? 'Exit focus mode' : 'Focus mode'} aria-pressed={focus}
                className="no-print rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink">
                {focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </button>
            )}
          </div>
          {subtitle && <p className="mt-0.5 max-w-3xl text-sm text-ink-2">{subtitle}</p>}
        </div>
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">
        {actions}
        {chrome && (
          <button type="button" onClick={openShortcutHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink">
            <Keyboard className="size-4" /> ?
          </button>
        )}
        {guide && (typeof guide === 'string' ? (
          <a href={guide} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">
            <BookOpen className="size-4" /> Guide
          </a>
        ) : (
          <Button size="sm" onClick={guide}><BookOpen className="size-4" /> Guide</Button>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ small controls

export function Switch({ checked, onChange, disabled, label, size = 'md', className }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; size?: 'sm' | 'md'; className?: string
}) {
  const sm = size === 'sm'
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-40',
        sm ? 'h-4 w-7' : 'h-5 w-9', checked ? 'bg-brand-700' : 'bg-line-2', className)}>
      <span className={cn('inline-block rounded-full bg-white shadow transition-transform', sm ? 'size-3' : 'size-4',
        checked ? (sm ? 'translate-x-3.5' : 'translate-x-4.5') : 'translate-x-0.5')} />
    </button>
  )
}

/** Copy a value (UHID, IP number, bill number…) to the clipboard. */
export function CopyButton({ value, label = 'Copy', className }: { value?: string | null; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  if (!value) return null
  return (
    <button type="button" title={`${label}: ${value}`} aria-label={`${label} ${value}`}
      className={cn('inline-grid size-5 shrink-0 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink', className)}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200) }).catch(() => {})
      }}>
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </button>
  )
}

/** Click-to-open popover anchored under its trigger; closes on outside click and Escape. */
export function Popover({ trigger, children, align = 'right', className, open: controlled, onOpenChange }: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right'; className?: string; open?: boolean; onOpenChange?: (v: boolean) => void
}) {
  const [inner, setInner] = useState(false)
  const open = controlled ?? inner
  const set = (v: boolean) => { if (controlled === undefined) setInner(v); onOpenChange?.(v) }
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) set(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') set(false) }
    document.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k) }
  })
  return (
    <div ref={box} className="relative">
      {trigger({ open, toggle: () => set(!open) })}
      {open && (
        <div className={cn('absolute z-40 mt-1 min-w-48 rounded-xl border border-line bg-surface py-1 shadow-xl', align === 'right' ? 'right-0' : 'left-0', className)}>
          {typeof children === 'function' ? children(() => set(false)) : children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ icon, children, onClick, danger, disabled, hint }: {
  icon?: string; children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50', danger ? 'text-red-600' : 'text-ink')}>
      {icon && <Icon name={icon} className="size-4 shrink-0 text-ink-3" />}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </button>
  )
}

export function StatTile({ label, value, hint, icon, tone, onClick }: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: string; tone?: 'default' | 'alert'; onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn('flex min-w-0 flex-col rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
        onClick && 'hover:border-brand-600/40 hover:bg-surface-2', tone === 'alert' && 'border-red-300 dark:border-red-500/40')}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
        {icon && <Icon name={icon} className="size-3.5" />}
        <span className="truncate">{label}</span>
      </span>
      <span className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</span>
      {hint && <span className="mt-0.5 text-xs text-ink-3">{hint}</span>}
    </button>
  )
}

export function Avatar({ name, size = 'md', className }: { name?: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const s = size === 'sm' ? 'size-7 text-[11px]' : size === 'lg' ? 'size-12 text-base' : 'size-9 text-xs'
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-full bg-brand-100 font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200', s, className)}>
      {initials(name)}
    </span>
  )
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-ink-3', className)}>
      <Loader2 className="size-5 animate-spin" /> {label ?? 'Loading…'}
    </div>
  )
}

export function Empty({ icon = 'Inbox', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-surface-2 text-ink-3"><Icon name={icon} className="size-6" /></div>
      <p className="mt-3 text-sm font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-ink-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error)
  return <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">{msg}</div>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{children}</kbd>
}

// ------------------------------------------------------------------ form controls

const control = 'w-full rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink placeholder:text-ink-3 shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-surface-2 disabled:text-ink-2'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return <input ref={ref} className={cn(control, 'h-9', invalid && 'border-red-500 focus:ring-red-500/20', className)} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cn(control, 'py-2', invalid && 'border-red-500', className)} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...rest }, ref) {
    return <select ref={ref} className={cn(control, 'h-9 pr-8', invalid && 'border-red-500', className)} {...rest}>{children}</select>
  },
)

export function FieldWrap({ label, required, error, help, children, className, htmlFor }: {
  label?: ReactNode; required?: boolean; error?: string; help?: ReactNode; children: ReactNode; className?: string; htmlFor?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {label && (
        <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-2">
          {label}{required && <span className="ml-0.5 text-red-600">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : help ? <p className="mt-1 text-xs text-ink-3">{help}</p> : null}
    </div>
  )
}

// ------------------------------------------------------------------ overlays

function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, active])
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  useEscape(onClose, open)
  if (!open) return null
  const w = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : size === 'xl' ? 'max-w-5xl' : 'max-w-xl'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[8vh] backdrop-blur-[1px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={cn('w-full rounded-2xl border border-line bg-surface shadow-2xl', w)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={onClose} aria-label="Close"><X className="size-5" /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-2xl', headerExtra }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; headerExtra?: ReactNode
}) {
  useEscape(onClose, open)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal className={cn('flex h-full w-full flex-col border-l border-line bg-surface shadow-2xl', width)}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-ink-2">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2">
            {headerExtra}
            <button className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={onClose} aria-label="Close"><X className="size-5" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </aside>
    </div>,
    document.body,
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { key: T; label: ReactNode; icon?: string; count?: number }[]; value: T; onChange: (k: T) => void; className?: string
}) {
  return (
    <div className={cn('flex gap-1 overflow-x-auto border-b border-line scroll-thin', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.key ? 'border-brand-700 text-brand-800 dark:border-brand-400 dark:text-brand-300' : 'border-transparent text-ink-2 hover:text-ink')}
        >
          {t.icon && <Icon name={t.icon} className="size-4" />}
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-2 ring-1 ring-line">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
      {options.map((o) => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium', value === o.key ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function KeyValue({ items, cols = 2 }: { items: { label: ReactNode; value: ReactNode; full?: boolean }[]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', cols === 3 ? 'sm:grid-cols-3' : cols === 2 ? 'sm:grid-cols-2' : '')}>
      {items.map((it, i) => (
        <div key={i} className={cn('min-w-0', it.full && 'sm:col-span-full')}>
          <dt className="text-xs font-medium text-ink-3">{it.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}
