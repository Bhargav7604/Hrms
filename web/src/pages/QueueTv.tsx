import { useQuery } from '@tanstack/react-query'
import { Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, apiUrl } from '@/lib/api'

/**
 * Public TV board (/display/queue?queues=REG,BILL,DR-EMP-000003). Shows token numbers and counter
 * names only — never patient names (DPDP). Live over SSE, with a chime + flash when a token is called.
 */

interface Board {
  queue: string; name: string; room?: string | null; kind: 'counter' | 'doctor'
  serving: { label: string; status: string; called_at?: string | null; counter?: string | null }[]
  next: string[]; waiting: number; avg_wait_min?: number | null
}
interface Display { hospital: string; time: string; queues: Board[]; last_called: { queue: string; label: string; counter?: string | null; at?: string } | null }
interface CallEvent { type: string; queue: string; label: string; counter?: string | null; recall?: boolean }

const FLASH_MS = 9000

function useClock() {
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

function speakable(label: string) {
  return label.replace(/-/g, ' ').replace(/\d/g, (d) => ` ${d}`).replace(/\s+/g, ' ').trim()
}

export default function QueueTv() {
  const [params] = useSearchParams()
  const keys = useMemo(() => (params.get('queues') || 'REG,BILL,PHARM,LAB').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 12), [params])
  const queuesParam = keys.join(',')
  const now = useClock()
  const [flash, setFlash] = useState<(CallEvent & { name?: string; until: number }) | null>(null)
  const [sound, setSound] = useState(false)
  const [online, setOnline] = useState(true)
  const audio = useRef<AudioContext | null>(null)

  const q = useQuery({
    queryKey: ['public', 'queue-display', queuesParam],
    queryFn: () => api<Display>('/public/queue/display', { query: { queues: queuesParam } }),
    refetchInterval: 15_000,
    retry: true,
  })
  const { refetch } = q
  const data = q.data

  useEffect(() => { if (data?.hospital) document.title = `Token display · ${data.hospital}` }, [data?.hospital])

  const announce = useCallback((ev: CallEvent, name?: string) => {
    setFlash({ ...ev, name, until: Date.now() + FLASH_MS })
    if (!sound) return
    if (audio.current) chime(audio.current)
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(`Token ${speakable(ev.label)}, please proceed to ${ev.counter || name || 'the counter'}`)
      u.lang = 'en-IN'
      u.rate = 0.9
      window.setTimeout(() => window.speechSynthesis.speak(u), 1100)
    }
  }, [sound])

  const names = useRef<Record<string, string>>({})
  useEffect(() => { data?.queues.forEach((b) => { names.current[b.queue] = b.name }) }, [data])

  useEffect(() => {
    const es = new EventSource(apiUrl('/public/realtime/queue'))
    es.onopen = () => setOnline(true)
    es.onerror = () => setOnline(false)
    es.addEventListener('queue', (msg) => {
      try {
        const ev = JSON.parse((msg as MessageEvent).data) as CallEvent
        if (!keys.includes(ev.queue)) return
        if (ev.type === 'called') announce(ev, names.current[ev.queue])
        refetch()
      } catch { /* ignore malformed */ }
    })
    return () => es.close()
  }, [keys, announce, refetch])

  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), Math.max(0, flash.until - Date.now()))
    return () => window.clearTimeout(t)
  }, [flash])

  const enableSound = () => {
    try {
      audio.current ??= new AudioContext()
      void audio.current.resume()
      chime(audio.current)
      setSound(true)
    } catch { setSound(false) }
  }

  const boards = data?.queues ?? []
  const cols = boards.length <= 1 ? 1 : boards.length <= 4 ? 2 : boards.length <= 6 ? 3 : 4
  return (
    <div className="flex h-screen min-h-[540px] flex-col overflow-hidden bg-slate-950 text-white antialiased" style={{ colorScheme: 'dark' }}>
      <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-[2vw] py-[1.2vh]">
        <div className="min-w-0">
          <div className="truncate text-[clamp(18px,2.2vw,44px)] font-bold tracking-tight">{data?.hospital ?? 'Token display'}</div>
          <div className="text-[clamp(12px,1vw,20px)] text-cyan-200/80">Please wait for your token number to be called · कृपया अपने टोकन की प्रतीक्षा करें · దయచేసి మీ టోకెన్ కోసం వేచి ఉండండి</div>
        </div>
        <div className="flex items-center gap-[1.5vw]">
          {!online && <span className="rounded bg-amber-500 px-2 py-1 text-[clamp(11px,0.9vw,18px)] font-semibold text-black">Reconnecting…</span>}
          <button onClick={() => (sound ? setSound(false) : enableSound())}
            className="flex items-center gap-2 rounded-lg border border-white/20 px-3 py-1.5 text-[clamp(12px,0.9vw,18px)] text-white/80 hover:bg-white/10"
            aria-label={sound ? 'Mute announcements' : 'Enable sound'}>
            {sound ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}{sound ? 'Sound on' : 'Tap to enable sound'}
          </button>
          <div className="text-right">
            <div className="tabular text-[clamp(22px,2.8vw,56px)] font-bold leading-none">{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</div>
            <div className="text-[clamp(11px,0.9vw,18px)] text-white/70">{now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
          </div>
        </div>
      </header>

      {flash && (
        <div className="flex items-center justify-center gap-[3vw] bg-yellow-400 px-[2vw] py-[1.6vh] text-black motion-safe:animate-pulse" role="alert" aria-live="assertive">
          <span className="text-[clamp(16px,2vw,40px)] font-semibold">{flash.recall ? 'Calling again' : 'Now calling'}</span>
          <span className="tabular text-[clamp(40px,6vw,120px)] font-black leading-none tracking-wider">{flash.label}</span>
          <span className="text-[clamp(16px,2.2vw,44px)] font-bold">→ {flash.counter || flash.name}</span>
        </div>
      )}

      <main className="grid min-h-0 flex-1 gap-[1vw] p-[1vw]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }}>
        {q.isLoading && <div className="col-span-full grid place-items-center text-2xl text-white/60">Loading…</div>}
        {q.error && !data && <div className="col-span-full grid place-items-center text-2xl text-amber-300">Display is offline — retrying…</div>}
        {boards.map((b) => {
          const hot = flash && flash.queue === b.queue
          return (
            <section key={b.queue} className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border-2 bg-slate-900 ${hot ? 'border-yellow-400 shadow-[0_0_40px_rgb(250_204_21/0.35)]' : 'border-white/10'}`}>
              <div className="flex items-baseline justify-between gap-3 bg-cyan-900/60 px-[1.2vw] py-[0.8vh]">
                <h2 className="truncate text-[clamp(16px,1.9vw,40px)] font-bold">{b.name}</h2>
                {b.room && <span className="shrink-0 text-[clamp(14px,1.4vw,30px)] font-semibold text-cyan-200">{b.room}</span>}
              </div>
              <div className="flex min-h-0 flex-1 flex-col px-[1.2vw] py-[1vh]">
                <div className="text-[clamp(11px,0.9vw,18px)] font-semibold uppercase tracking-[0.2em] text-white/60">Now serving</div>
                {b.serving.length === 0 ? (
                  <div className="py-[1.5vh] text-[clamp(18px,2vw,40px)] text-white/40">—</div>
                ) : (
                  <ul className="min-h-0 flex-1 space-y-[0.6vh] overflow-hidden py-[0.6vh]">
                    {b.serving.slice(0, cols >= 3 ? 2 : 3).map((s) => (
                      <li key={s.label} className={`flex items-baseline justify-between gap-3 rounded-xl px-[0.8vw] ${hot && flash?.label === s.label ? 'bg-yellow-400 text-black' : 'bg-white/5'}`}>
                        <span className={`tabular font-black leading-tight tracking-wide ${hot && flash?.label === s.label ? '' : 'text-yellow-300'}`}
                          style={{ fontSize: `clamp(32px, ${cols >= 3 ? 4 : 5.5}vw, ${cols >= 3 ? 90 : 130}px)` }}>{s.label}</span>
                        <span className="truncate text-right text-[clamp(14px,1.5vw,32px)] font-semibold">{s.counter ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto border-t border-white/10 pt-[0.8vh]">
                  <div className="flex items-center justify-between text-[clamp(11px,0.9vw,18px)] uppercase tracking-[0.2em] text-white/60">
                    <span>Next</span>
                    <span className="normal-case tracking-normal">{b.waiting} waiting{b.avg_wait_min != null ? ` · ~${Math.round(b.avg_wait_min)} min` : ''}</span>
                  </div>
                  <div className="mt-[0.5vh] flex flex-wrap gap-[0.5vw]">
                    {b.next.length === 0 ? <span className="text-[clamp(14px,1.4vw,28px)] text-white/40">No one waiting</span> :
                      b.next.map((n) => <span key={n} className="tabular rounded-lg bg-white/10 px-[0.7vw] py-[0.3vh] text-[clamp(16px,1.8vw,38px)] font-bold">{n}</span>)}
                  </div>
                </div>
              </div>
            </section>
          )
        })}
      </main>
      <footer className="border-t border-white/10 bg-slate-900 px-[2vw] py-[0.8vh] text-center text-[clamp(11px,1vw,20px)] text-white/70">
        Emergency, senior citizen and differently-abled patients are served first · Keep your token slip ready
      </footer>
    </div>
  )
}
