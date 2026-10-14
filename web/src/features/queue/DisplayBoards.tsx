import { useQuery } from '@tanstack/react-query'
import { Copy, ExternalLink, MonitorPlay } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { EntityView, useEntity } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, Segmented, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { useQueueAccess, type QueueMaster } from './access'
import type { BoardConfig, Monitor } from './types'

interface Queues {
  counters: { id: string; name: string; queue: string; type?: string; status: string; waiting?: number }[]
  doctors: { queue: string; name: string; department?: string | null; waiting?: number }[]
}

const STORE = 'vlack.queue.display'
const TV_W = 1920
const TV_H = 1080
const MASTERS: { fqn: QueueMaster; label: string }[] = [
  { fqn: 'queue.queues', label: 'Queues' }, { fqn: 'queue.counters', label: 'Counters & Cabins' }, { fqn: 'queue.display_boards', label: 'Display Boards' },
]

export const boardPath = (code: string) => `/queue/board/${encodeURIComponent(code)}`
export const departmentPath = (dept: string) => `/queue/department/${encodeURIComponent(dept)}`
const absolute = (path: string) => `${window.location.origin}${path}`
const copy = (path: string) => {
  navigator.clipboard?.writeText(absolute(path)).then(() => toast.success('Link copied'), () => toast.error('Copy failed'))
}

type Source = 'boards' | 'departments' | 'adhoc'

/**
 * Display Boards workspace: configured TV boards (Queue Management › Display Boards) with their public
 * links, department screens, an ad-hoc queue picker, one live 1920×1080 preview — and, for roles that
 * may edit them, the queue / counter / board masters.
 */
export function DisplayBoards() {
  const access = useQueueAccess()
  const masters = MASTERS.filter((m) => access.master(m.fqn))
  const [view, setView] = useState<'screens' | 'masters'>('screens')
  if (!access.ready) return <Spinner />
  if (!access.display) return <Empty icon="Lock" title="Display boards are not available for your role" />
  return (
    <div className="space-y-4">
      {masters.length > 0 && (
        <Segmented value={view} onChange={setView} options={[{ key: 'screens', label: 'Screens & links' }, { key: 'masters', label: 'Manage masters' }]} />
      )}
      {view === 'masters' && masters.length > 0 ? <Masters items={masters} /> : <Screens />}
    </div>
  )
}

function Screens() {
  const access = useQueueAccess()
  const boards = useQuery({ queryKey: ['x', 'queue', 'boards'], queryFn: () => api<BoardConfig[]>('/queue/boards'), enabled: access.boards })
  const monitor = useQuery({
    queryKey: ['x', 'queue', 'monitor', { kind: '', dept: '' }],
    queryFn: () => api<Monitor>('/queue/monitor'),
    enabled: access.readTokens,
    staleTime: 60_000,
  })
  const queues = useQuery({ queryKey: ['x', 'queue', 'queues'], queryFn: () => api<Queues>('/queue/queues'), enabled: access.readTokens })

  const [source, setSource] = useState<Source>(access.boards ? 'boards' : 'adhoc')
  const [board, setBoard] = useState<string | null>(null)
  const [dept, setDept] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORE) ?? 'null') ?? [] } catch { return [] }
  })
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(picked)) } catch { /* storage unavailable */ } }, [picked])
  useEffect(() => {
    if (!picked.length && queues.data) setPicked([...new Set(queues.data.counters.map((c) => c.queue))].slice(0, 4))
  }, [queues.data, picked.length])
  // first active board is previewed by default
  useEffect(() => {
    if (!board && boards.data?.length) setBoard((boards.data.find((b) => b.status !== 'Inactive') ?? boards.data[0]).code)
  }, [boards.data, board])
  const departments = monitor.data?.departments ?? []
  useEffect(() => { if (!dept && departments.length) setDept(departments[0].id) }, [departments, dept])

  const adhocPath = `/display/queue?queues=${encodeURIComponent(picked.join(','))}`
  const selBoard = boards.data?.find((b) => b.code === board)
  const preview = source === 'boards'
    ? selBoard ? { path: boardPath(selBoard.code), label: selBoard.name, off: selBoard.status === 'Inactive' } : null
    : source === 'departments'
      ? dept ? { path: departmentPath(dept), label: departments.find((d) => d.id === dept)?.name ?? 'Department screen', off: false } : null
      : picked.length ? { path: adhocPath, label: `${picked.length} queue${picked.length === 1 ? '' : 's'}`, off: false } : null

  const sources = [
    access.boards && { key: 'boards' as const, label: 'Boards' },
    access.readTokens && { key: 'departments' as const, label: 'Department screens' },
    access.readTokens && { key: 'adhoc' as const, label: 'Pick queues' },
  ].filter(Boolean) as { key: Source; label: string }[]

  if (!sources.length) return <Empty icon="Lock" title="No screens available">Your role cannot read display boards or queue tokens.</Empty>
  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
        {sources.length > 1 && <Segmented value={source} onChange={setSource} options={sources} />}
        {source === 'boards' && (
          <BoardList boards={boards.data} loading={boards.isLoading} error={boards.error} selected={board}
            canCreate={access.master('queue.display_boards')}
            onSelect={setBoard} onDepartment={(id) => { setDept(id); setSource('departments') }} />
        )}
        {source === 'departments' && (
          <Card title="Department screens" icon="Building2" pad={false}>
            {monitor.isLoading && <Spinner />}
            {monitor.error && <div className="p-3"><ErrorBox error={monitor.error} /></div>}
            {monitor.data && departments.length === 0 && <Empty icon="Building2" title="No department has doctor cabins today" />}
            <ul className="max-h-[56vh] divide-y divide-line overflow-y-auto scroll-thin">
              {departments.map((d) => {
                const lines = monitor.data?.lines.filter((l) => l.department_id === d.id) ?? []
                return (
                  <Row key={d.id} selected={dept === d.id} onSelect={() => setDept(d.id)} title={
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <button type="button" aria-pressed={dept === d.id} className={rowTitle} onClick={(e) => { e.stopPropagation(); setDept(d.id) }}>{d.name}</button>
                        <span className="block truncate text-xs text-ink-3">{lines.length} line{lines.length === 1 ? '' : 's'} · {lines.reduce((n, l) => n + l.waiting, 0)} waiting</span>
                      </div>
                      <LinkButtons path={departmentPath(d.id)} />
                    </div>
                  } />
                )
              })}
            </ul>
            <p className="px-4 py-3 text-xs text-ink-3">Each department screen shows its doctors consulting today with room, session, now serving and next tokens.</p>
          </Card>
        )}
        {source === 'adhoc' && <AdhocPicker queues={queues.data} loading={queues.isLoading} error={queues.error} picked={picked} setPicked={setPicked} />}
      </div>

      <Preview preview={preview} />
    </div>
  )
}

function LinkButtons({ path }: { path: string }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <button type="button" title="Copy link" aria-label="Copy link" className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink" onClick={() => copy(path)}>
        <Copy className="size-4" />
      </button>
      <a href={path} target="_blank" rel="noopener" title="Open on this device" aria-label="Open in a new tab" className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink">
        <ExternalLink className="size-4" />
      </a>
    </span>
  )
}

/** A selectable row: the title is the keyboard target, the whole row is clickable with the mouse. */
function Row({ selected, onSelect, title, children }: { selected: boolean; onSelect: () => void; title: ReactNode; children?: ReactNode }) {
  return (
    <li onClick={onSelect} className={cn('cursor-pointer px-4 py-2.5 hover:bg-surface-2', selected && 'bg-brand-50 dark:bg-brand-500/10')}>
      {title}
      {children}
    </li>
  )
}

const rowTitle = 'block max-w-full truncate text-left text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 rounded'

function BoardList({ boards, loading, error, selected, canCreate, onSelect, onDepartment }: {
  boards?: BoardConfig[]; loading: boolean; error: unknown; selected: string | null; canCreate: boolean
  onSelect: (code: string) => void; onDepartment: (id: string) => void
}) {
  return (
    <Card title="Configured boards" icon="Tv" pad={false}>
      {loading && <Spinner />}
      {error ? <div className="p-3"><ErrorBox error={error} /></div> : null}
      {boards && boards.length === 0 && (
        <Empty icon="Tv" title="No display boards yet">
          {canCreate ? 'Add one under Manage masters › Display Boards: name, location, queues or a department.' : 'Ask the front office to configure one.'}
        </Empty>
      )}
      <ul className="max-h-[56vh] divide-y divide-line overflow-y-auto scroll-thin">
        {boards?.map((b) => (
          <Row key={b.id} selected={selected === b.code} onSelect={() => onSelect(b.code)} title={
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <button type="button" aria-pressed={selected === b.code} className={rowTitle} onClick={(e) => { e.stopPropagation(); onSelect(b.code) }}>{b.name}</button>
                  {b.status === 'Inactive' && <StatusBadge status="Inactive" />}
                </div>
                <div className="truncate text-xs text-ink-3">{[b.code, b.location, b.announce === false ? 'no sound' : null].filter(Boolean).join(' · ')}</div>
              </div>
              <LinkButtons path={boardPath(b.code)} />
            </div>
          }>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(b.queues ?? []).map((k) => <Badge key={k} tone="cyan">{k}</Badge>)}
              {b.department && <Badge tone="violet">{b.department_name ?? 'Department'} cabins</Badge>}
              {!b.queues?.length && !b.department && <span className="text-xs text-amber-700 dark:text-amber-300">No queues configured</span>}
            </div>
            <code className="mt-1.5 block truncate text-[11px] text-ink-3">{boardPath(b.code)}</code>
            {b.department && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onDepartment(b.department!) }} title={departmentPath(b.department)}
                className="mt-1 max-w-full truncate text-left text-xs text-brand-700 hover:underline dark:text-brand-300">
                {b.department_name ?? 'Department'} department screen →
              </button>
            )}
          </Row>
        ))}
      </ul>
    </Card>
  )
}

function AdhocPicker({ queues, loading, error, picked, setPicked }: {
  queues?: Queues; loading: boolean; error: unknown; picked: string[]; setPicked: (f: (p: string[]) => string[]) => void
}) {
  const options = useMemo(() => {
    const out = new Map<string, { label: string; hint: string; group: 'Counters' | 'Doctor cabins' }>()
    queues?.counters.forEach((c) => {
      const cur = out.get(c.queue)
      out.set(c.queue, { label: c.type ?? c.queue, hint: cur ? `${cur.hint}, ${c.name}` : c.name, group: 'Counters' })
    })
    queues?.doctors.forEach((d) => out.set(d.queue, { label: d.name, hint: d.department ?? '', group: 'Doctor cabins' }))
    return out
  }, [queues])
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : p.length >= 12 ? p : [...p, k]))
  return (
    <Card title="Queues on this screen" icon="ListChecks" pad={false}>
      {loading && <Spinner />}
      {error ? <div className="p-3"><ErrorBox error={error} /></div> : null}
      {(['Counters', 'Doctor cabins'] as const).map((g) => {
        const items = [...options.entries()].filter(([, v]) => v.group === g)
        if (!items.length) return null
        return (
          <div key={g}>
            <div className="border-y border-line bg-surface-2 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">{g}</div>
            <ul className="max-h-[36vh] overflow-y-auto scroll-thin">
              {items.map(([k, v]) => (
                <li key={k}>
                  <label className={cn('flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-surface-2', picked.includes(k) && 'bg-brand-50 dark:bg-brand-500/10')}>
                    <input type="checkbox" className="size-4 accent-brand-700" checked={picked.includes(k)} onChange={() => toggle(k)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{v.label}</span>
                      <span className="block truncate text-xs text-ink-3">{k}{v.hint ? ` · ${v.hint}` : ''}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-2">
        {picked.map((k) => <Badge key={k} tone="cyan">{options.get(k)?.label ?? k}</Badge>)}
        {!picked.length && <span className="text-sm text-ink-3">Choose at least one queue.</span>}
      </div>
      <p className="px-4 pb-3 text-xs text-ink-3">Up to 12 queues per screen. For a permanent screen, save it as a display board so its link never changes.</p>
    </Card>
  )
}

function Preview({ preview }: { preview: { path: string; label: string; off: boolean } | null }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.4)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / TV_W))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const url = preview ? absolute(preview.path) : ''
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"><MonitorPlay className="size-4 text-brand-700 dark:text-brand-400" /> {preview?.label ?? 'Preview'}</span>
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-2">{url || 'Choose a screen'}</code>
        <Button size="sm" disabled={!preview} onClick={() => preview && copy(preview.path)}><Copy className="size-4" /> Copy link</Button>
        <Button size="sm" variant="primary" disabled={!preview} onClick={() => preview && window.open(preview.path, '_blank', 'noopener')}><ExternalLink className="size-4" /> Open on this device</Button>
      </div>
      {preview?.off && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">This board is switched off (Inactive) — its link shows “switched off” until it is made Active.</p>}
      <div ref={box} className="relative w-full overflow-hidden rounded-xl border border-line bg-slate-950 shadow-sm" style={{ aspectRatio: `${TV_W} / ${TV_H}` }}>
        {preview && (
          <iframe key={preview.path} title={`TV preview — ${preview.label}`} src={preview.path} className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
            style={{ width: TV_W, height: TV_H, transform: `scale(${scale})` }} />
        )}
      </div>
      <p className="text-xs text-ink-3">
        Preview at 1920×1080. On the TV, open the link in a full-screen browser (F11) and tap “enable sound” once for the chime and voice announcement.
        Boards show token numbers, counters, rooms and doctors only — never patient names (DPDP Act).
      </p>
    </div>
  )
}

function Masters({ items }: { items: { fqn: QueueMaster; label: string }[] }) {
  const [fqn, setFqn] = useState<QueueMaster>(items[0].fqn)
  const entity = useEntity(fqn)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={fqn} onChange={setFqn} options={items.map((m) => ({ key: m.fqn, label: m.label }))} />
        {entity?.description && <p className="text-xs text-ink-3">{entity.description}</p>}
      </div>
      {entity ? <EntityView key={fqn} entity={entity} /> : <Spinner />}
    </div>
  )
}
