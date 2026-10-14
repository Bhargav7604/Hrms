import { Download, Search } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { Button, Input } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { date, dateTime } from '@/lib/format'

/** `/` focuses the list search (unless typing in a field). */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== '/' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      ref.current?.focus()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [ref])
}

export function SearchBox({ value, onChange, placeholder, inputRef }: { value: string; onChange: (v: string) => void; placeholder: string; inputRef?: RefObject<HTMLInputElement | null> }) {
  return (
    <div className="relative w-full sm:w-80">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
      <Input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8 pr-8" aria-label={placeholder} />
      <kbd className="pointer-events-none absolute right-2 top-2 rounded border border-line-2 px-1 font-mono text-[10px] text-ink-3">/</kbd>
    </div>
  )
}

export interface Col<T> { label: string; value: (r: T) => unknown }

const cell = (v: unknown) => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return dateTime(s)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return date(s)
  return s
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function download(name: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Excel-compatible CSV, JSON and a printable table of every row matching the current filters. */
export function ExportButtons<T>({ title, columns, fetchAll }: { title: string; columns: Col<T>[]; fetchAll: () => Promise<T[]> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const run = async (kind: 'csv' | 'xls' | 'json' | 'print') => {
    setOpen(false)
    setBusy(true)
    try {
      const rows = await fetchAll()
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      if (kind === 'json') download(`${slug}.json`, 'application/json', JSON.stringify(rows, null, 2))
      else if (kind === 'csv' || kind === 'xls') {
        const sep = kind === 'xls' ? '\t' : ','
        const q = (s: string) => (kind === 'csv' ? `"${s.replace(/"/g, '""')}"` : s.replace(/[\t\n]/g, ' '))
        const body = [columns.map((c) => q(c.label)).join(sep), ...rows.map((r) => columns.map((c) => q(cell(c.value(r)))).join(sep))].join('\n')
        download(`${slug}.${kind === 'xls' ? 'xls' : 'csv'}`, kind === 'xls' ? 'application/vnd.ms-excel' : 'text/csv;charset=utf-8', '﻿' + body)
      } else {
        const w = window.open('', '_blank')
        if (!w) { toast.error('Allow pop-ups to print'); return }
        w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:12px system-ui;margin:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left}th{background:#f1f5f9}@page{size:landscape;margin:12mm}</style></head><body><h2>${esc(title)}</h2><p>${rows.length} records · printed ${esc(dateTime(new Date().toISOString()))}</p><table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(cell(c.value(r)))}</td>`).join('')}</tr>`).join('')}</tbody></table><script>onload=()=>print()</script></body></html>`)
        w.document.close()
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div ref={box} className="relative">
      <Button size="sm" loading={busy} onClick={() => setOpen(!open)} aria-expanded={open}><Download className="size-4" />Export</Button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-44 rounded-lg border border-line bg-surface py-1 text-sm shadow-xl">
          {([['xls', 'Excel'], ['csv', 'CSV'], ['json', 'JSON'], ['print', 'Print table']] as const).map(([k, l]) => (
            <button key={k} role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => run(k)}>{l}</button>
          ))}
        </div>
      )}
    </div>
  )
}
