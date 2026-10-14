import { ArrowDown, ArrowUp, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Columns3, Download, Rows3, Rows4 } from 'lucide-react'
import { toast } from 'sonner'
import { api, apiUrl, errorMessage } from '@/lib/api'
import { date, dateTime } from '@/lib/format'
import { Button, cn, MenuItem, Popover } from './ui'

/** List toolbar pieces shared by EntityView and bespoke lists: column chooser, export menu, pager, density. */

export interface ColumnOption { key: string; label: string }

export function ColumnChooser({ all, value, onChange, onReset }: {
  all: ColumnOption[]; value: string[]; onChange: (cols: string[]) => void; onReset: () => void
}) {
  const label = new Map(all.map((c) => [c.key, c.label]))
  const shown = value.filter((k) => label.has(k))
  const hidden = all.filter((c) => !shown.includes(c.key))
  const move = (i: number, d: number) => {
    const next = [...shown]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <Popover className="w-72" trigger={({ toggle, open }) => (
      <Button size="sm" variant="secondary" onClick={toggle} aria-expanded={open} title="Choose and order columns">
        <Columns3 className="size-4" /> <span className="hidden xl:inline">Columns</span>
      </Button>
    )}>
      <div className="flex items-center justify-between border-b border-line px-3 pb-2 pt-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">Columns · {shown.length} shown</span>
        <button type="button" className="text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={onReset}>Reset</button>
      </div>
      <div className="max-h-80 overflow-y-auto py-1 scroll-thin">
        {shown.map((k, i) => (
          <div key={k} className="flex items-center gap-2 px-3 py-1 text-sm hover:bg-surface-2">
            <input type="checkbox" className="size-4 accent-brand-700" checked disabled={shown.length <= 1}
              onChange={() => onChange(shown.filter((x) => x !== k))} aria-label={`Hide ${label.get(k)}`} />
            <span className="min-w-0 flex-1 truncate text-ink">{label.get(k)}</span>
            <button type="button" className="rounded p-0.5 text-ink-3 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-3.5" /></button>
            <button type="button" className="rounded p-0.5 text-ink-3 hover:text-ink disabled:opacity-30" disabled={i === shown.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-3.5" /></button>
          </div>
        ))}
        {hidden.length > 0 && <div className="mt-1 border-t border-line px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Hidden</div>}
        {hidden.map((c) => (
          <label key={c.key} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm text-ink-2 hover:bg-surface-2">
            <input type="checkbox" className="size-4 accent-brand-700" checked={false} onChange={() => onChange([...shown, c.key])} />
            <span className="truncate">{c.label}</span>
          </label>
        ))}
      </div>
    </Popover>
  )
}

export function DensityToggle({ value, onChange }: { value: 'comfortable' | 'compact'; onChange: (v: 'comfortable' | 'compact') => void }) {
  const compact = value === 'compact'
  return (
    <Button size="sm" variant="secondary" onClick={() => onChange(compact ? 'comfortable' : 'compact')}
      title={compact ? 'Comfortable rows' : 'Compact rows'} aria-label={compact ? 'Comfortable rows' : 'Compact rows'}>
      {compact ? <Rows3 className="size-4" /> : <Rows4 className="size-4" />}
    </Button>
  )
}

type Query = Record<string, string | number | boolean | null | undefined>

/** Excel (server-side .xlsx), CSV, JSON downloads and a print-friendly table of the current filters. */
export function ExportMenu({ path, query, printTitle, printColumns, subtitle }: {
  path: string; query: Query; printTitle: string; printColumns?: string[]; subtitle?: string
}) {
  const href = (ext: string) => apiUrl(`${path}/export.${ext}`, query, true)
  return (
    <Popover className="w-52" trigger={({ toggle, open }) => (
      <Button size="sm" variant="secondary" onClick={toggle} aria-expanded={open}><Download className="size-4" /> <span className="hidden xl:inline">Export</span></Button>
    )}>
      {(close) => (
        <>
          <a href={href('xlsx')} onClick={close} className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-2">
            <span className="grid size-5 place-items-center rounded bg-emerald-600 text-[10px] font-bold text-white">X</span> Excel (.xlsx)
          </a>
          <a href={href('csv')} onClick={close} className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-2">
            <span className="grid size-5 place-items-center rounded bg-slate-500 text-[9px] font-bold text-white">CSV</span> CSV
          </a>
          <a href={href('json')} onClick={close} className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-2">
            <span className="grid size-5 place-items-center rounded bg-amber-500 text-[9px] font-bold text-white">{'{}'}</span> JSON
          </a>
          <div className="my-1 border-t border-line" />
          <MenuItem icon="Printer" onClick={() => { close(); printList(path, query, printTitle, printColumns, subtitle) }}>Print table</MenuItem>
          <p className="px-3 pb-1 pt-1 text-[11px] text-ink-3">Up to 10,000 rows with the current filters. Exports are audited.</p>
        </>
      )}
    </Popover>
  )
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return dateTime(s)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return date(s)
  return s
}

export async function printList(path: string, query: Query, title: string, columns?: string[], subtitle?: string) {
  const w = window.open('', '_blank')
  if (!w) { toast.error('Allow pop-ups to print'); return }
  w.document.write('<p style="font:14px system-ui;padding:24px">Preparing the table…</p>')
  try {
    const data = await api<{ label: string; total: number; columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }>(
      `${path}/export.json`, { query: { ...query, inline: 1, cols: columns?.join(',') } })
    const head = data.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')
    const body = data.rows.map((r) => `<tr>${data.columns.map((c) => `<td>${esc(fmt(r[c.key]))}</td>`).join('')}</tr>`).join('')
    w.document.open()
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f1720;margin:24px}
      h1{font-size:18px;margin:0 0 2px} .sub{color:#4b5563;margin-bottom:12px}
      table{border-collapse:collapse;width:100%} th,td{border:1px solid #cfd6de;padding:4px 6px;text-align:left;vertical-align:top}
      th{background:#f4f6f8;font-weight:600} tr:nth-child(even) td{background:#fafbfc}
      .foot{margin-top:10px;color:#8a919c;font-size:11px} @page{size:landscape;margin:12mm}
    </style></head><body><h1>${esc(title)}</h1><div class="sub">${esc(subtitle ?? '')} ${data.rows.length} of ${data.total} records · printed ${esc(dateTime(new Date().toISOString()))}</div>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="foot">Vlack HRMS — confidential patient information. Handle per hospital policy.</div>
    <script>window.onload=()=>{window.print()}</script></body></html>`)
    w.document.close()
  } catch (e) {
    w.close()
    toast.error(errorMessage(e))
  }
}

export const PAGE_SIZES = [25, 50, 100, 200]

export function Pager({ page, limit, total, onPage, onLimit, fetching }: {
  page: number; limit: number; total: number; onPage: (p: number) => void; onLimit?: (n: number) => void; fetching?: boolean
}) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-ink-2', fetching && 'opacity-70')}>
      <span className="tabular">{total ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total.toLocaleString('en-IN')} records` : '0 records'}</span>
      <div className="flex items-center gap-3">
        {onLimit && (
          <label className="flex items-center gap-1.5">
            Rows
            <select className="h-7 rounded-md border border-line-2 bg-surface px-1.5 text-xs" value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <div className="flex items-center gap-0.5">
          <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page"><ChevronFirst className="size-4" /></Button>
          <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
          <span className="tabular px-1">Page {page} of {pages}</span>
          <Button size="xs" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
          <Button size="xs" variant="ghost" disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Last page"><ChevronLast className="size-4" /></Button>
        </div>
      </div>
    </div>
  )
}
