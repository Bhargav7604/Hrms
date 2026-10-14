import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format, isToday, parseISO, startOfWeek } from 'date-fns'
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Copy, Eraser, Plus, Send, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, Kbd, Modal, Select, Spinner } from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import type { BespokeProps } from './index'

// ------------------------------------------------------------------ types

interface Shift {
  id: string; code?: string; name: string; shift_code?: string; shift_type?: string; start_time?: string; end_time?: string
  hours?: number; color?: string; status?: string; label: string
}
interface Conflict { type: 'leave' | 'double' | 'rest' | 'consecutive'; message: string }
interface Entry {
  id: string; code?: string; shift: string; label: string; shift_name?: string; shift_type?: string; start?: string; end?: string
  color?: string; status: string; ward?: string | null; ward_code?: string | null; role_on_duty?: string | null
  changed_after_publish?: boolean; conflicts: Conflict[]
}
interface LeaveMark { id: string; code?: string; leave_type: string; short: string; status: string; half_day: boolean }
interface Row {
  id: string; code?: string; name: string; category?: string; designation?: string; department_id?: string; home_ward?: string | null
  hours: number; cells: Record<string, Entry[]>; leave: Record<string, LeaveMark>
}
interface StaffingDay { required: number; M: number; E: number; N: number; gap: number }
interface Grid {
  week_start: string; days: string[]; category: string | null; shifts: Shift[]; employees: Row[]
  staffing: null | { ward: string; ward_name: string; ward_type: string; ratio: string; census: number; high_acuity: number; ventilated: number; required_per_shift: number; days: Record<string, StaffingDay> }
  summary: { employees: number; planned: number; published: number; conflicts: number }
}
interface Options {
  wards: { id: string; code: string; name: string; ward_type: string; ratio: string }[]
  departments: { id: string; code: string; name: string }[]
  shifts: Shift[]
  categories: string[]
}
interface CellChange { employee_id: string; date: string; shift_id: string | null; ward?: string; department?: string; mode?: 'replace' | 'add' }
type Target = { kind: 'cell'; row: Row; day: string } | { kind: 'row'; row: Row } | { kind: 'col'; day: string }

// ------------------------------------------------------------------ shift colours (always paired with the text code)

const CHIP: Record<string, string> = {
  Sky: 'bg-sky-100 text-sky-900 dark:bg-sky-500/25 dark:text-sky-100',
  Amber: 'bg-amber-100 text-amber-900 dark:bg-amber-500/25 dark:text-amber-100',
  Indigo: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-500/30 dark:text-indigo-100',
  Emerald: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-100',
  Rose: 'bg-rose-100 text-rose-900 dark:bg-rose-500/25 dark:text-rose-100',
  Slate: 'bg-slate-200 text-slate-900 dark:bg-slate-500/30 dark:text-slate-100',
}
const TYPE_COLOR: Record<string, string> = { Morning: 'Sky', Evening: 'Amber', Night: 'Indigo', General: 'Emerald', 'On-call': 'Rose' }
const chipClass = (s: { color?: string | null; shift_type?: string | null }) => CHIP[s.color ?? ''] ?? CHIP[TYPE_COLOR[s.shift_type ?? ''] ?? 'Slate']
const CONFLICT_LABEL: Record<Conflict['type'], string> = { leave: 'On leave', double: 'Double shift', rest: 'Rest < 11 h', consecutive: '> 6 days in a row' }

const mondayOf = (d: Date) => format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd')
const WARD_KEY = 'vlack.roster.ward'
const remembered = () => { try { return localStorage.getItem(WARD_KEY) ?? '' } catch { return '' } }
const remember = (v: string) => { try { localStorage.setItem(WARD_KEY, v) } catch { /* storage unavailable */ } }

// ------------------------------------------------------------------ page

export default function RosterPlanner(_: BespokeProps) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const canWrite = reg.canEntity('roster.rosters', 'write')
  const [week, setWeek] = useState(() => mondayOf(new Date()))
  const [ward, setWard] = useState<string>(remembered)
  const [department, setDepartment] = useState('')
  const [category, setCategory] = useState('')
  const [include, setInclude] = useState<string[]>([])
  const [target, setTarget] = useState<{ t: Target; rect: DOMRect } | null>(null)
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null)
  const [conflictReport, setConflictReport] = useState<{ employee: string; date: string; messages: string[] }[] | null>(null)
  const [adding, setAdding] = useState(false)
  const cellRefs = useRef(new Map<string, HTMLButtonElement>())

  const options = useQuery({ queryKey: ['x', 'roster', 'options'], queryFn: () => api<Options>('/hr/roster/options'), staleTime: 5 * 60_000 })
  useEffect(() => {
    if (options.data && ward && !options.data.wards.some((w) => w.id === ward)) setWard('')
  }, [options.data, ward])

  const query = { week_start: week, ward, department, category, include: include.join(',') }
  const grid = useQuery({
    queryKey: ['x', 'roster', 'grid', query],
    queryFn: () => api<Grid>('/hr/roster', { query }),
    placeholderData: (prev) => prev,
  })
  const data = grid.data
  const shifts = useMemo(() => (data?.shifts ?? options.data?.shifts ?? []).filter((s) => s.status === 'Active'), [data, options.data])
  const byKey = useMemo(() => new Map(shifts.map((s) => [s.label.toUpperCase(), s])), [shifts])

  const refresh = () => qc.invalidateQueries({ queryKey: ['x', 'roster'] })
  const save = useMutation({
    mutationFn: (cells: CellChange[]) => api<{ created: number; updated: number; cleared: number; unchanged: number; conflicts: unknown[] }>(
      '/hr/roster/cells', { method: 'PUT', body: { cells } }),
    onSuccess: (r) => {
      const changed = r.created + r.updated + r.cleared
      if (changed > 1 || r.conflicts.length) {
        toast.success(`${changed} shift${changed === 1 ? '' : 's'} updated${r.conflicts.length ? ` · ${r.conflicts.length} with conflicts` : ''}`)
      }
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const publish = useMutation({
    mutationFn: (force: boolean) => api<{ published: number; employees: number; with_conflicts: number }>('/hr/roster/publish', {
      method: 'POST', body: { week_start: week, ward: ward || undefined, department: department || undefined, force },
    }),
    onSuccess: (r) => {
      setConflictReport(null)
      toast.success(`Published ${r.published} shifts for ${r.employees} staff${r.with_conflicts ? ` (${r.with_conflicts} with conflicts)` : ''}`)
      refresh()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ROSTER_CONFLICTS') setConflictReport((e.details?.conflicts as never) ?? [])
      else toast.error(errorMessage(e))
    },
  })
  const copy = useMutation({
    mutationFn: () => api<{ created: number; skipped: Record<string, number> }>('/hr/roster/copy', {
      method: 'POST', body: { week_start: week, ward: ward || undefined, department: department || undefined },
    }),
    onSuccess: (r) => {
      const skipped = Object.entries(r.skipped).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')
      toast.success(`Copied ${r.created} shifts from last week${skipped ? ` · skipped ${skipped}` : ''}`)
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const scope = useCallback((row?: Row) => ({
    ward: ward || undefined, department: ward ? undefined : department || row?.department_id || undefined,
  }), [ward, department])

  const apply = useCallback((t: Target, shiftId: string | null, mode: 'replace' | 'add' = 'replace') => {
    if (!data || !canWrite) return
    const cells: CellChange[] = []
    const push = (row: Row, day: string) => {
      if (shiftId && row.leave[day] && !row.leave[day].half_day && row.leave[day].status === 'Approved' && t.kind !== 'cell') return
      cells.push({ employee_id: row.id, date: day, shift_id: shiftId, mode, ...scope(row) })
    }
    if (t.kind === 'cell') push(t.row, t.day)
    else if (t.kind === 'row') data.days.forEach((d) => push(t.row, d))
    else data.employees.forEach((r) => push(r, t.day))
    if (cells.length) save.mutate(cells)
    setTarget(null)
  }, [data, canWrite, save, scope])

  const openAt = (t: Target, el: HTMLElement) => { if (canWrite) setTarget({ t, rect: el.getBoundingClientRect() }) }

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!data || !focus || target) return
    const { r, c } = focus
    const move = (dr: number, dc: number) => {
      const nr = Math.max(0, Math.min(data.employees.length - 1, r + dr))
      const nc = Math.max(0, Math.min(6, c + dc))
      setFocus({ r: nr, c: nc })
      cellRefs.current.get(`${nr}:${nc}`)?.focus()
      e.preventDefault()
    }
    if (e.key === 'ArrowDown') return move(1, 0)
    if (e.key === 'ArrowUp') return move(-1, 0)
    if (e.key === 'ArrowRight') return move(0, 1)
    if (e.key === 'ArrowLeft') return move(0, -1)
    const row = data.employees[r]
    const day = data.days[c]
    if (!row || !day || !canWrite) return
    if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '0') {
      e.preventDefault()
      return apply({ kind: 'cell', row, day }, null)
    }
    const sh = byKey.get(e.key.toUpperCase())
    if (sh && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      apply({ kind: 'cell', row, day }, sh.id, e.shiftKey ? 'add' : 'replace')
      move(0, 1)
    }
  }

  const wardInfo = options.data?.wards.find((w) => w.id === ward)
  const weekLabel = `${format(parseISO(week), 'dd MMM')} – ${format(addDays(parseISO(week), 6), 'dd MMM yyyy')}`

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-line-2 bg-surface shadow-sm">
          <button className="rounded-l-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Previous week" onClick={() => setWeek(mondayOf(addDays(parseISO(week), -7)))}><ChevronLeft className="size-4" /></button>
          <span className="min-w-44 px-2 text-center text-sm font-medium tabular text-ink">{weekLabel}</span>
          <button className="rounded-r-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Next week" onClick={() => setWeek(mondayOf(addDays(parseISO(week), 7)))}><ChevronRight className="size-4" /></button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setWeek(mondayOf(new Date()))}><CalendarDays className="size-4" />This week</Button>
        <div className="w-56"><Select aria-label="Ward" className="h-8" value={ward} onChange={(e) => { setWard(e.target.value); remember(e.target.value); setInclude([]) }}>
          <option value="">All wards</option>
          {options.data?.wards.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
        </Select></div>
        <div className="w-48"><Select aria-label="Department" className="h-8" value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">All departments</option>
          {options.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select></div>
        <div className="w-40"><Select aria-label="Staff category" className="h-8" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{ward ? 'Nurses' : 'All categories'}</option>
          {ward && <option value="All">All categories</option>}
          {options.data?.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select></div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {data && (
            <span className="flex items-center gap-1.5 text-xs text-ink-2">
              <Badge tone="amber">{data.summary.planned} draft</Badge>
              <Badge tone="green">{data.summary.published} published</Badge>
              {data.summary.conflicts > 0 && <Badge tone="red"><AlertTriangle className="size-3" />{data.summary.conflicts} conflicts</Badge>}
            </span>
          )}
          {canWrite && (
            <>
              <Button size="sm" onClick={() => setAdding(true)}><UserPlus className="size-4" />Add staff</Button>
              <Button size="sm" loading={copy.isPending} onClick={() => {
                if (data && data.summary.planned + data.summary.published > 0 && !confirm('This week already has shifts. Copy only fills days that are still empty — continue?')) return
                copy.mutate()
              }}><Copy className="size-4" />Copy last week</Button>
              <Button size="sm" variant="primary" loading={publish.isPending} disabled={!data?.summary.planned} onClick={() => publish.mutate(false)}>
                <Send className="size-4" />Publish{data?.summary.planned ? ` ${data.summary.planned}` : ''}
              </Button>
            </>
          )}
        </div>
      </div>

      {wardInfo && data?.staffing && (
        <p className="text-xs text-ink-2">
          <span className="font-medium text-ink">{wardInfo.name}</span> · {wardInfo.ward_type} · target {data.staffing.ratio} ·
          census {data.staffing.census} (current occupancy){data.staffing.high_acuity ? ` · ${data.staffing.high_acuity} high-acuity` : ''}
          {data.staffing.ventilated ? ` · ${data.staffing.ventilated} ventilated` : ''} → <b className="text-ink">{data.staffing.required_per_shift} nurses per shift</b>
        </p>
      )}

      {grid.error && <ErrorBox error={grid.error} />}
      {grid.isLoading && <Spinner label="Loading roster…" />}
      {data && data.employees.length === 0 && (
        <Card>
          <Empty icon="CalendarRange" title={ward ? 'No staff on this ward roster yet' : 'No staff match these filters'}
            action={canWrite ? <Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="size-4" />Add staff to the roster</Button> : undefined}>
            {ward ? 'Set the home ward on staff profiles, copy last week, or add staff here to start planning.' : 'Change the department or category filter.'}
          </Empty>
        </Card>
      )}

      {data && data.employees.length > 0 && (
        <div className={cn('overflow-hidden rounded-xl border border-line bg-surface', grid.isFetching && 'opacity-80')}>
          <div className="max-h-[68vh] overflow-auto scroll-thin" onKeyDown={onGridKey}>
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-20">
                <tr className="bg-surface-2 text-xs text-ink-2">
                  <th className="sticky left-0 z-30 min-w-56 border-b border-r border-line bg-surface-2 px-3 py-2 text-left font-medium">
                    Staff <span className="font-normal text-ink-3">({data.employees.length})</span>
                  </th>
                  {data.days.map((d) => {
                    const today = isToday(parseISO(d))
                    return (
                      <th key={d} className={cn('min-w-28 border-b border-line px-1.5 py-1.5 text-left font-medium', today && 'bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-200')}>
                        <div className="flex items-center justify-between gap-1">
                          <span><span className="text-ink-3">{format(parseISO(d), 'EEE')}</span> <span className="tabular text-ink">{format(parseISO(d), 'dd')}</span>{today && <span className="ml-1 text-[10px] uppercase">today</span>}</span>
                          {canWrite && (
                            <button className="rounded px-1 text-[11px] text-ink-3 hover:bg-surface hover:text-ink" title="Fill this day for everyone shown"
                              onClick={(e) => openAt({ kind: 'col', day: d }, e.currentTarget)}>Fill</button>
                          )}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {data.employees.map((row, r) => (
                  <tr key={row.id} className="group">
                    <th scope="row" className="sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-1.5 text-left font-normal group-hover:bg-surface-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">{row.name}</div>
                          <div className="truncate text-xs text-ink-3">{row.designation}{row.home_ward && row.home_ward !== ward && ward ? ' · float' : ''}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className={cn('tabular text-xs', row.hours > 48 ? 'font-semibold text-red-600' : 'text-ink-3')} title="Rostered hours this week">{row.hours}h</span>
                          {canWrite && (
                            <button className="rounded px-1 text-[11px] text-ink-3 opacity-0 hover:bg-surface-2 hover:text-ink group-hover:opacity-100 focus:opacity-100"
                              title="Fill the whole week" onClick={(e) => openAt({ kind: 'row', row }, e.currentTarget)}>Fill</button>
                          )}
                        </div>
                      </div>
                    </th>
                    {data.days.map((d, c) => (
                      <td key={d} className={cn('border-b border-line p-0.5 align-top', isToday(parseISO(d)) && 'bg-brand-50/40 dark:bg-brand-500/5')}>
                        <RosterCell row={row} day={d} canWrite={canWrite} ward={ward}
                          refCb={(el) => { if (el) cellRefs.current.set(`${r}:${c}`, el); else cellRefs.current.delete(`${r}:${c}`) }}
                          onFocus={() => setFocus({ r, c })}
                          onOpen={(el) => openAt({ kind: 'cell', row, day: d }, el)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {data.staffing && (
                <tfoot className="sticky bottom-0 z-20">
                  <tr className="bg-surface-2 text-xs">
                    <th className="sticky left-0 z-30 border-r border-t border-line bg-surface-2 px-3 py-2 text-left font-medium text-ink-2">
                      Nurse staffing<div className="font-normal text-ink-3">rostered / required per shift</div>
                    </th>
                    {data.days.map((d) => <StaffingCell key={d} s={data.staffing!.days[d]} />)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <Legend shifts={shifts} canWrite={canWrite} />
        </div>
      )}

      {target && (
        <ShiftPopover rect={target.rect} target={target.t} shifts={shifts} pending={save.isPending}
          onPick={(id, mode) => apply(target.t, id, mode)} onClose={() => setTarget(null)} />
      )}

      <Modal open={!!conflictReport} onClose={() => setConflictReport(null)} title="Resolve roster conflicts before publishing?" size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setConflictReport(null)}>Go back and fix</Button>
          <Button variant="warning" loading={publish.isPending} onClick={() => publish.mutate(true)}>Publish anyway</Button>
        </>}>
        <p className="mb-3 text-sm text-ink-2">These draft shifts break rostering rules (approved leave, double shifts, less than 11 hours rest, more than 6 consecutive working days). Publishing anyway is recorded in the audit trail.</p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {conflictReport?.map((c, i) => (
            <li key={i} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
              <span className="font-medium text-ink">{c.employee}</span>
              <span className="tabular text-ink-2">{format(parseISO(c.date), 'EEE dd MMM')}</span>
              <span className="w-full text-xs text-red-700 dark:text-red-300">{c.messages.join(' · ')}</span>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add staff to this roster" size="sm">
        <p className="mb-2 text-sm text-ink-2">Bring a float, agency or cross-trained colleague into this week's grid. They stay on the roster once a shift is assigned.</p>
        <RefPicker refName="employees.employees" value={null} placeholder="Search staff by name or code…" autoFocus
          filter={{ status: 'Active' }} onChange={(id) => {
            if (id && !include.includes(id)) setInclude([...include, id])
            setAdding(false)
          }} />
        {include.length > 0 && (
          <div className="mt-3 flex items-center justify-between text-xs text-ink-2">
            <span>{include.length} added this session</span>
            <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setInclude([])}><X className="size-3" />Clear</button>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ------------------------------------------------------------------ cells

function RosterCell({ row, day, canWrite, ward, onOpen, onFocus, refCb }: {
  row: Row; day: string; canWrite: boolean; ward: string; onOpen: (el: HTMLElement) => void; onFocus: () => void; refCb: (el: HTMLButtonElement | null) => void
}) {
  const entries = row.cells[day] ?? []
  const leave = row.leave[day]
  const conflicts = entries.flatMap((e) => e.conflicts)
  const title = [
    ...entries.map((e) => `${e.shift_name ?? e.label} ${e.start ?? ''}–${e.end ?? ''} · ${e.status}${e.ward_code ? ` · ${e.ward_code}` : ''}`),
    leave ? `${leave.leave_type} leave (${leave.status})${leave.half_day ? ', half day' : ''}` : '',
    ...conflicts.map((c) => `⚠ ${c.message}`),
  ].filter(Boolean).join('\n')
  return (
    <button ref={refCb} type="button" onFocus={onFocus} onClick={(e) => onOpen(e.currentTarget)} title={title || (canWrite ? 'Click, or focus and type a shift code' : undefined)}
      aria-label={`${row.name}, ${format(parseISO(day), 'EEEE dd MMM')}: ${title || 'off'}`}
      className={cn('relative flex h-11 w-full flex-wrap content-center items-center gap-1 rounded-md px-1 text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-brand-600', canWrite ? 'hover:bg-surface-2' : 'cursor-default',
        leave && leave.status === 'Approved' && !leave.half_day && 'bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(245_158_11/0.12)_6px_12px)]',
        conflicts.length > 0 && 'ring-1 ring-inset ring-red-500/60')}>
      {entries.map((e) => (
        <span key={e.id} className={cn('inline-flex h-6 min-w-7 items-center justify-center gap-0.5 rounded px-1.5 text-xs font-semibold', chipClass(e),
          e.status === 'Planned' && 'border border-dashed border-current/60 opacity-90')}>
          {e.label}
          {e.ward_code && e.ward !== ward && <span className="text-[9px] font-normal opacity-70">{e.ward_code}</span>}
          {e.changed_after_publish && <span className="text-[10px] text-amber-700 dark:text-amber-300" aria-label="changed after publishing">•</span>}
        </span>
      ))}
      {leave && (
        <span className={cn('inline-flex h-6 items-center rounded px-1 text-[11px] font-semibold',
          leave.status === 'Approved' ? 'text-amber-800 dark:text-amber-300' : 'text-ink-3 italic')}>
          {leave.short}{leave.status !== 'Approved' ? '?' : ''}{leave.half_day ? '½' : ''}
        </span>
      )}
      {!entries.length && !leave && <span className="w-full text-center text-xs text-ink-3/60">·</span>}
      {conflicts.length > 0 && (
        <span className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-red-600 text-[10px] font-bold text-white" aria-label={`${conflicts.length} conflicts`}>!</span>
      )}
    </button>
  )
}

function StaffingCell({ s }: { s?: StaffingDay }) {
  if (!s) return <td className="border-t border-line" />
  return (
    <td className="border-t border-line px-1.5 py-1.5 align-top">
      <div className="flex flex-col gap-0.5 tabular">
        {(['M', 'E', 'N'] as const).map((k) => {
          const short = s[k] < s.required
          return (
            <span key={k} className={cn('flex items-center justify-between rounded px-1', short ? 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200' : 'text-ink-2')}>
              <span className="font-semibold">{k}</span><span>{s[k]}/{s.required}</span>
            </span>
          )
        })}
        <span className={cn('px-1 text-[11px] font-medium', s.gap ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300')}>
          {s.gap ? `Short ${s.gap}` : 'Covered'}
        </span>
      </div>
    </td>
  )
}

function Legend({ shifts, canWrite }: { shifts: Shift[]; canWrite: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2 text-xs text-ink-2">
      {shifts.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1.5">
          <span className={cn('inline-flex h-5 min-w-6 items-center justify-center rounded px-1 font-semibold', chipClass(s))}>{s.label}</span>
          {s.name} {s.start_time}–{s.end_time}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5"><span className="inline-flex h-5 w-6 items-center justify-center rounded border border-dashed border-ink-3 text-[10px]">M</span>Draft</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-4 w-6 rounded bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(245_158_11/0.35)_4px_8px)]" />Approved leave (CL/SL/EL…; “?” = pending)</span>
      <span className="inline-flex items-center gap-1.5"><span className="grid size-4 place-items-center rounded-full bg-red-600 text-[10px] font-bold text-white">!</span>Conflict</span>
      {canWrite && (
        <span className="ml-auto inline-flex items-center gap-1 text-ink-3">
          Arrows move · <Kbd>M</Kbd><Kbd>E</Kbd><Kbd>N</Kbd><Kbd>G</Kbd> assign · <Kbd>Shift</Kbd>+code adds a second shift · <Kbd>Del</Kbd> clears
        </span>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ shift picker popover

function ShiftPopover({ rect, target, shifts, pending, onPick, onClose }: {
  rect: DOMRect; target: Target; shifts: Shift[]; pending: boolean; onPick: (shiftId: string | null, mode?: 'replace' | 'add') => void; onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [add, setAdd] = useState(false)
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const scroll = () => onClose()
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', scroll)
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); window.removeEventListener('resize', scroll) }
  }, [onClose])
  const width = 272
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const below = rect.bottom + 320 < window.innerHeight
  const style = below ? { left, top: rect.bottom + 4, width } : { left, bottom: window.innerHeight - rect.top + 4, width }

  let heading: ReactNode
  let entries: Entry[] = []
  let leave: LeaveMark | undefined
  if (target.kind === 'cell') {
    heading = <>{target.row.name}<span className="font-normal text-ink-3"> · {format(parseISO(target.day), 'EEE dd MMM')}</span></>
    entries = target.row.cells[target.day] ?? []
    leave = target.row.leave[target.day]
  } else if (target.kind === 'row') {
    heading = <>Fill the week · {target.row.name}</>
  } else {
    heading = <>Fill {format(parseISO(target.day), 'EEE dd MMM')} for everyone shown</>
  }
  const conflicts = entries.flatMap((e) => e.conflicts)

  return createPortal(
    <div ref={box} role="dialog" aria-label="Choose shift" style={style}
      className="fixed z-50 rounded-xl border border-line bg-surface p-2 shadow-2xl">
      <div className="mb-1.5 flex items-start justify-between gap-2 px-1">
        <div className="text-sm font-medium text-ink">{heading}</div>
        <button className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={onClose} aria-label="Close"><X className="size-4" /></button>
      </div>
      {leave && (
        <div className="mb-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {leave.leave_type} leave · {leave.status}{leave.half_day ? ' · half day' : ''} ({leave.code})
        </div>
      )}
      {target.kind !== 'cell' && <p className="mb-1.5 px-1 text-xs text-ink-3">Days on approved leave are skipped.</p>}
      <div className="grid gap-1">
        {shifts.map((s) => {
          const current = entries.some((e) => e.shift === s.id)
          return (
            <button key={s.id} disabled={pending} onClick={() => onPick(s.id, add ? 'add' : 'replace')}
              className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50', current && 'bg-brand-50 dark:bg-brand-500/10')}>
              <span className={cn('inline-flex h-6 min-w-7 items-center justify-center rounded px-1.5 text-xs font-semibold', chipClass(s))}>{s.label}</span>
              <span className="flex-1 text-ink">{s.name}</span>
              <span className="tabular text-xs text-ink-3">{s.start_time}–{s.end_time}</span>
            </button>
          )
        })}
        <button disabled={pending} onClick={() => onPick(null)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-2 hover:bg-surface-2 disabled:opacity-50">
          <span className="inline-flex h-6 min-w-7 items-center justify-center rounded border border-line-2 px-1.5"><Eraser className="size-3.5" /></span>
          {target.kind === 'cell' ? 'Off — clear this day' : 'Clear all'}
        </button>
      </div>
      {target.kind === 'cell' && entries.length > 0 && (
        <label className="mt-1.5 flex items-center gap-2 border-t border-line px-1 pt-1.5 text-xs text-ink-2">
          <input type="checkbox" className="accent-brand-700" checked={add} onChange={(e) => setAdd(e.target.checked)} />
          <Plus className="size-3" />Add as an additional shift (double duty)
        </label>
      )}
      {conflicts.length > 0 && (
        <ul className="mt-1.5 space-y-1 border-t border-line px-1 pt-1.5 text-xs text-red-700 dark:text-red-300">
          {conflicts.map((c, i) => <li key={i}><b>{CONFLICT_LABEL[c.type]}:</b> {c.message}</li>)}
        </ul>
      )}
    </div>,
    document.body,
  )
}
