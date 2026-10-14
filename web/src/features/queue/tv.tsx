import { useQuery } from '@tanstack/react-query'
import { Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { apiUrl } from '@/lib/api'
import type { BoardLine, DisplayState } from './types'

/**
 * Building blocks for the public TV screens (display boards, department screens). These screens are
 * always dark (TVs in a lobby), size their type with the viewport (1920×1080 first, still usable on a
 * tablet) and only ever show token numbers, counters, rooms and doctors — never patient names (DPDP).
 */

export class PublicError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

/** Plain fetch to the unauthenticated `/api/public/queue/...` endpoints. */
export async function publicGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/public/queue${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new PublicError(0, 'The display is offline — retrying…')
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new PublicError(res.status, (body && body.message) || res.statusText)
  return body as T
}

/** Poll a public screen every 5 s; a token change on the public SSE stream refreshes it at once. */
export function usePublicScreen<T>(key: readonly unknown[], path: string, enabled = true) {
  const q = useQuery({
    queryKey: ['public', 'queue', ...key],
    queryFn: ({ signal }) => publicGet<T>(path, signal),
    enabled,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
    retry: (n, e) => !(e instanceof PublicError && e.status >= 400 && e.status < 500) && n < 2,
  })
  const { refetch } = q
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return
    const es = new EventSource(apiUrl('/public/realtime/queue'))
    let t: number | undefined
    es.addEventListener('queue', () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => { void refetch() }, 300)
    })
    return () => { window.clearTimeout(t); es.close() }
  }, [enabled, refetch])
  return q
}

export function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

function chime(ctx: AudioContext) {
  const t0 = ctx.currentTime
  ;[[880, 0], [660, 0.32], [990, 0.64]].forEach(([f, dt]) => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = f
    g.gain.setValueAtTime(0.0001, t0 + dt)
    g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.45)
    o.connect(g).connect(ctx.destination)
    o.start(t0 + dt)
    o.stop(t0 + dt + 0.5)
  })
}

/** "REG-007" → "R E G 0 0 7" style spacing so text-to-speech reads it digit by digit. */
const speakable = (label: string) => label.replace(/-/g, ' ').replace(/\d/g, (d) => ` ${d}`).replace(/\s+/g, ' ').trim()

/** Browsers only allow audio after a user gesture: the screen shows an "enable sound" button. */
export function useSound() {
  const ctx = useRef<AudioContext | null>(null)
  const [on, setOn] = useState(false)
  const toggle = () => {
    if (on) { setOn(false); return }
    try {
      ctx.current ??= new AudioContext()
      void ctx.current.resume()
      chime(ctx.current)
      setOn(true)
    } catch { setOn(false) }
  }
  const play = useCallback((speech?: string) => {
    if (!on) return
    if (ctx.current) chime(ctx.current)
    if (speech && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(speech)
      u.lang = 'en-IN'
      u.rate = 0.9
      window.setTimeout(() => window.speechSynthesis.speak(u), 1100)
    }
  }, [on])
  useEffect(() => () => { void ctx.current?.close() }, [])
  return { on, toggle, play }
}

export interface CallFlash { queue: string; label: string; place?: string | null; recall: boolean; until: number }
const FLASH_MS = 9_000

/**
 * Watches `last_called` between polls: a new call (or a recall of the same token) flashes a banner
 * and plays the chime + announcement. Nothing is announced on the first load.
 */
export function useCallFlash(data: DisplayState | undefined, play: (speech?: string) => void, announce = true) {
  const prev = useRef<{ key: string | null; token: string | null } | null>(null)
  const [flash, setFlash] = useState<CallFlash | null>(null)
  useEffect(() => {
    if (!data) return
    const lc = data.last_called
    const token = lc ? `${lc.queue}|${lc.label}` : null
    const key = lc ? `${token}|${lc.at ?? ''}` : null
    const before = prev.current
    prev.current = { key, token }
    if (!before || !lc || key === before.key) return
    const line = data.queues.find((q) => q.queue === lc.queue)
    const place = (line?.kind === 'doctor' ? line.room : lc.counter) || lc.counter || line?.room || line?.name
    setFlash({ queue: lc.queue, label: lc.label, place, recall: token === before.token, until: Date.now() + FLASH_MS })
    if (announce) play(`Token ${speakable(lc.label)}, please proceed to ${place || 'the counter'}`)
  }, [data, play, announce])
  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), Math.max(0, flash.until - Date.now()))
    return () => window.clearTimeout(t)
  }, [flash])
  return flash
}

/** Columns for N cards on a 16:9 screen. */
export const tvColumns = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4)

export function TvScreen({ title, subtitle, sound, offline, flash, children, footer }: {
  title: ReactNode; subtitle?: ReactNode; sound?: { on: boolean; toggle: () => void }; offline?: boolean
  flash?: CallFlash | null; children: ReactNode; footer?: ReactNode
}) {
  const now = useClock()
  return (
    <div className="flex h-dvh min-h-[480px] flex-col overflow-hidden bg-slate-950 text-white antialiased" style={{ colorScheme: 'dark' }}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-[2vw] py-[1.2vh]">
        <div className="min-w-0">
          <div className="truncate text-[clamp(18px,2.2vw,44px)] font-bold tracking-tight">{title}</div>
          {subtitle && <div className="truncate text-[clamp(12px,1vw,20px)] text-cyan-200/80">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-[1.5vw]">
          {offline && (
            <span className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-2 py-1 text-[clamp(11px,0.9vw,18px)] font-semibold text-black">
              <WifiOff className="size-4" /> Reconnecting…
            </span>
          )}
          {sound && (
            <button type="button" onClick={sound.toggle} aria-pressed={sound.on}
              className="flex items-center gap-2 rounded-lg border border-white/20 px-3 py-1.5 text-[clamp(12px,0.9vw,18px)] text-white/80 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-yellow-300">
              {sound.on ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}{sound.on ? 'Sound on' : 'Tap to enable sound'}
            </button>
          )}
          <div className="text-right">
            <div className="tabular text-[clamp(22px,2.8vw,56px)] font-bold leading-none">
              {now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </div>
            <div className="text-[clamp(11px,0.9vw,18px)] text-white/70">
              {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
        </div>
      </header>
      {flash && (
        <div role="alert" aria-live="assertive"
          className="flex flex-wrap items-center justify-center gap-x-[3vw] gap-y-1 bg-yellow-400 px-[2vw] py-[1.6vh] text-black motion-safe:animate-pulse">
          <span className="text-[clamp(16px,2vw,40px)] font-semibold">{flash.recall ? 'Calling again' : 'Now calling'}</span>
          <span className="tabular text-[clamp(40px,6vw,120px)] font-black leading-none tracking-wider">{flash.label}</span>
          {flash.place && <span className="text-[clamp(16px,2.2vw,44px)] font-bold">→ {flash.place}</span>}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto md:overflow-hidden">{children}</main>
      {footer}
    </div>
  )
}

/** Card grid: one column on phones, a fixed TV grid (rows share the height) from tablet width up. */
export function TvGrid({ count, children }: { count: number; children: ReactNode }) {
  const style = { '--cols': tvColumns(count) } as CSSProperties
  return (
    <div style={style}
      className="grid grid-cols-1 gap-[1vw] p-[1vw] md:h-full md:auto-rows-[minmax(0,1fr)] md:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]">
      {children}
    </div>
  )
}

export function TvMessage({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <div className={`grid h-full min-h-[40vh] place-items-center p-8 text-center text-[clamp(18px,2vw,36px)] ${tone === 'warn' ? 'text-amber-300' : 'text-white/60'}`}>
      <div>{children}</div>
    </div>
  )
}

/** Scrolling message line at the bottom of a board (static when the viewer prefers reduced motion). */
export function Ticker({ text, note }: { text?: string | null; note: string }) {
  return (
    <footer className="border-t border-white/10 bg-slate-900 py-[0.8vh] text-[clamp(12px,1.1vw,22px)] text-white/80">
      <style>{`@keyframes vq-ticker{from{transform:translateX(0)}to{transform:translateX(-100%)}}
        .vq-ticker{display:inline-block;padding-left:100%;white-space:nowrap;animation:vq-ticker 28s linear infinite}
        @media (prefers-reduced-motion: reduce){.vq-ticker{animation:none;padding-left:2vw}}`}</style>
      {text ? (
        <div className="overflow-hidden whitespace-nowrap" aria-label={text}>
          <span className="vq-ticker">{text}  ·  {note}</span>
        </div>
      ) : <div className="px-[2vw] text-center">{note}</div>}
    </footer>
  )
}

/** One queue line on a TV: now serving (token + counter/room), next tokens and the waiting count. */
export function TvLineCard({ line: b, title, meta, cols, hot, hotLabel }: {
  line: BoardLine; title: ReactNode; meta?: ReactNode; cols: number; hot?: boolean; hotLabel?: string
}) {
  const big = cols >= 3
  return (
    <section className={`flex min-h-[220px] flex-col overflow-hidden rounded-2xl border-2 bg-slate-900 md:min-h-0 ${hot ? 'border-yellow-400 shadow-[0_0_40px_rgb(250_204_21/0.35)]' : 'border-white/10'}`}>
      <div className="flex items-baseline justify-between gap-3 bg-cyan-900/60 px-[1.2vw] py-[0.8vh] max-md:px-4">
        <h2 className="min-w-0 truncate text-[clamp(16px,1.9vw,40px)] font-bold">{title}</h2>
        {meta && <span className="shrink-0 text-[clamp(13px,1.3vw,28px)] font-semibold text-cyan-200">{meta}</span>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-[1.2vw] py-[1vh] max-md:px-4">
        <div className="text-[clamp(11px,0.9vw,18px)] font-semibold uppercase tracking-[0.2em] text-white/60">Now serving</div>
        {b.serving.length === 0 ? (
          <div className="py-[1.5vh] text-[clamp(18px,2vw,40px)] text-white/40">—</div>
        ) : (
          <ul className="min-h-0 flex-1 space-y-[0.6vh] overflow-hidden py-[0.6vh]">
            {b.serving.slice(0, big ? 2 : 3).map((s) => {
              const isHot = hot && hotLabel === s.label
              const place = b.kind === 'doctor' ? b.room ?? s.counter : s.counter
              return (
                <li key={s.label} className={`flex items-center justify-between gap-3 rounded-xl px-[0.8vw] max-md:px-3 ${isHot ? 'bg-yellow-400 text-black' : 'bg-white/5'}`}>
                  <span className="shrink-0">
                    <span className={`tabular block whitespace-nowrap font-black leading-tight tracking-wide ${isHot ? '' : 'text-yellow-300'}`}
                      style={{ fontSize: `clamp(32px, ${big ? 4 : 5.5}vw, ${big ? 90 : 130}px)` }}>{s.label}</span>
                    <span className={`block text-[clamp(11px,0.85vw,17px)] font-semibold uppercase tracking-wider ${isHot ? 'text-black/70' : 'text-white/55'}`}>
                      {s.status === 'Serving' ? 'In service' : 'Please proceed'}
                    </span>
                  </span>
                  {place && <span className="min-w-0 truncate text-right text-[clamp(14px,1.5vw,32px)] font-semibold">{place}</span>}
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-auto border-t border-white/10 pt-[0.8vh]">
          <div className="flex items-center justify-between gap-2 text-[clamp(11px,0.9vw,18px)] uppercase tracking-[0.2em] text-white/60">
            <span>Next</span>
            <span className="normal-case tracking-normal">{b.waiting} waiting{b.waiting > 0 && b.avg_wait_min ? ` · ~${Math.round(b.avg_wait_min)} min` : ''}</span>
          </div>
          <div className="mt-[0.5vh] flex flex-wrap gap-[0.5vw] max-md:gap-2">
            {b.next.length === 0
              ? <span className="text-[clamp(14px,1.4vw,28px)] text-white/40">No one waiting</span>
              : b.next.map((n) => <span key={n} className="tabular rounded-lg bg-white/10 px-[0.7vw] py-[0.3vh] text-[clamp(16px,1.8vw,38px)] font-bold max-md:px-2">{n}</span>)}
          </div>
        </div>
      </div>
    </section>
  )
}
