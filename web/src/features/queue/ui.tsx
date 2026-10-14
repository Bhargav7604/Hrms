import { Badge, StatusBadge, type BadgeTone } from '@/components/ui'

/** Small shared pieces for the queue screens. */

const PRIORITY_TONE: Record<string, BadgeTone> = { Emergency: 'red', 'Senior Citizen': 'violet', 'Differently Abled': 'violet', Normal: 'gray' }

/** Priority chip; "Normal" is the default and shows nothing unless `showNormal`. */
export function PriorityBadge({ p, showNormal }: { p?: string | null; showNormal?: boolean }) {
  if (!p || (p === 'Normal' && !showNormal)) return null
  return <Badge tone={PRIORITY_TONE[p] ?? 'gray'}>{p}</Badge>
}

/** Skipped tokens are "held" at the counter — they can be called again later today. */
export const statusLabel = (s?: string | null) => (s === 'Skipped' ? 'Held' : s ?? '')

/** Token status with a text label; Skipped reads "Held", transferred tokens say where they went. */
export function TokenStatus({ status, transferredTo }: { status?: string | null; transferredTo?: string | null }) {
  if (transferredTo) return <Badge tone="gray" dot>Transferred → {transferredTo}</Badge>
  if (status === 'Skipped') return <Badge tone="amber" dot>Held</Badge>
  return <StatusBadge status={status} />
}

export const isDoctorQueue = (queue: string) => queue.startsWith('DR-')

interface Groupable { queue: string; name: string; department?: string | null; department_id?: string | null }

/**
 * Lines grouped for pickers: counters & services (no department) first, then one group per
 * department (its queue masters, then doctor cabins), departments alphabetically.
 */
export function groupLines<T extends Groupable>(lines: T[]): { key: string; label: string; items: T[] }[] {
  const services = lines.filter((l) => !l.department_id && !isDoctorQueue(l.queue))
  const depts = new Map<string, { label: string; items: T[] }>()
  for (const l of lines) {
    if (services.includes(l)) continue
    const key = l.department_id ?? '_other'
    const g = depts.get(key) ?? { label: l.department ?? 'Other doctors', items: [] }
    g.items.push(l)
    depts.set(key, g)
  }
  const out = services.length ? [{ key: '_services', label: 'Counters & services', items: services }] : []
  const sorted = [...depts.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
  for (const [key, g] of sorted) {
    g.items.sort((a, b) => Number(isDoctorQueue(a.queue)) - Number(isDoctorQueue(b.queue)) || a.name.localeCompare(b.name))
    out.push({ key, label: g.label, items: g.items })
  }
  return out
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * Print a token slip (58/80 mm thermal friendly). Uses a hidden iframe instead of a pop-up so it
 * also works after an async issue and on kiosks that block pop-ups. Token number only — no
 * patient name on the slip.
 */
export function printSlip(s: { label: string; queueName: string; hospital: string; ahead: number; priority?: string | null; room?: string | null; estWaitMin?: number | null }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Token ${esc(s.label)}</title><style>
    @page{margin:4mm} body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;margin:0;color:#000}
    h1{font-size:14px;margin:0 0 6px} .q{font-size:13px;font-weight:600} .tok{font-size:54px;font-weight:800;letter-spacing:2px;margin:6px 0}
    p{margin:3px 0;font-size:12px} .s{font-size:10px;color:#333}</style></head><body>
    <h1>${esc(s.hospital)}</h1><div class="q">${esc(s.queueName)}${s.room ? ` · ${esc(s.room)}` : ''}</div>
    <div class="tok">${esc(s.label)}</div>
    <p>${s.ahead} ahead of you${s.estWaitMin ? ` · about ${Math.round(s.estWaitMin)} min` : ''}</p>
    ${s.priority && s.priority !== 'Normal' ? `<p><b>${esc(s.priority)}</b></p>` : ''}
    <p class="s">${esc(new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
    <p class="s">Please watch the display screen for your number.</p></body></html>`
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const win = frame.contentWindow
  if (!win) { frame.remove(); return }
  win.document.open()
  win.document.write(html)
  win.document.close()
  const cleanup = () => window.setTimeout(() => frame.remove(), 500)
  win.onafterprint = cleanup
  window.setTimeout(() => {
    try { win.focus(); win.print() } finally { window.setTimeout(() => frame.isConnected && frame.remove(), 60_000) }
  }, 60)
}
