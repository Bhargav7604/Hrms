import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, AtSign, CheckCircle2, CircleDot, Inbox, ListTodo, MailOpen, Pencil, Pin, PinOff, Search, Send, Trash2, X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker, useDebounced } from '@/components/fields'
import { Avatar, Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Spinner, Textarea, type BadgeTone } from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, dateTime } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'

type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
type MsgType = 'MESSAGE' | 'ALERT' | 'NOTICE'
interface Recipient { type: 'user' | 'department' | 'role'; id: string; label: string; sub?: string }
interface Msg {
  id: string; code: string; thread_id: string; sender_id: string; sender_name: string; subject: string; body?: string; body_preview?: string
  priority: Priority; type: MsgType; patient_id?: string | null; encounter_id?: string | null; patient_label?: string | null; encounter_label?: string | null
  is_task: boolean; task_status?: 'Open' | 'Closed' | null; task_closed_by?: string | null; task_closed_at?: string | null; is_draft: boolean
  audience: Recipient[]; created_at: string; sent_at?: string | null
  read?: boolean; pinned?: boolean; archived?: boolean; mentioned?: boolean; via?: string
  recipients?: { user_id: string; name: string; role: string; via: string; read_at?: string | null; mentioned: boolean }[]
}
interface ListResp { rows: Msg[]; total: number; folder: string }
interface Counts { unread: number; mentions: number; urgent: number; tasks_open: number; drafts: number }

const FOLDERS = [
  { key: 'inbox', label: 'Inbox', icon: Inbox },
  { key: 'tasks', label: 'Tasks', icon: ListTodo },
  { key: 'sent', label: 'Sent', icon: Send },
  { key: 'drafts', label: 'Drafts', icon: Pencil },
  { key: 'pinned', label: 'Pinned', icon: Pin },
  { key: 'archived', label: 'Archived', icon: Archive },
] as const
const PRIORITY_TONE: Record<Priority, BadgeTone> = { LOW: 'gray', NORMAL: 'blue', HIGH: 'amber', URGENT: 'red' }
const TYPE_TONE: Record<MsgType, BadgeTone> = { MESSAGE: 'gray', ALERT: 'red', NOTICE: 'violet' }

export function PriorityBadge({ p }: { p: Priority }) {
  return p === 'NORMAL' ? null : <Badge tone={PRIORITY_TONE[p]}>{p}</Badge>
}

export default function Messages() {
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const folder = params.get('folder') ?? 'inbox'
  const selected = params.get('m')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const [compose, setCompose] = useState<null | { draft?: Msg }>(params.get('compose') === '1' ? {} : null)
  const flag = (k: string) => params.get(k) === '1'
  const prio = params.get('priority') ?? ''
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v); else p.delete(k)
    if (k === 'folder') p.delete('m')
    setParams(p, { replace: k !== 'm' })
  }
  useEffect(() => {
    if (params.get('compose') !== '1') return
    const p = new URLSearchParams(params)
    p.delete('compose')
    setParams(p, { replace: true })
  }, [params, setParams])

  const query = { folder, q: dq, unread: flag('unread') || undefined, mentions: flag('mentions') || undefined, priority: prio || undefined }
  const list = useQuery({ queryKey: ['messages', 'list', query], queryFn: () => api<ListResp>('/messages', { query }), placeholderData: (p) => p })
  const counts = useQuery({ queryKey: ['messages', 'counts'], queryFn: () => api<Counts>('/messages/counts') })
  useShortcuts('Messages', [
    { keys: 'c', label: 'Compose a new message', run: () => setCompose({}) },
    { keys: 'j', label: 'Next message', run: () => step(1) },
    { keys: 'k', label: 'Previous message', run: () => step(-1) },
  ])
  const rows = list.data?.rows ?? []
  const step = (d: number) => {
    const i = rows.findIndex((r) => r.id === selected)
    const n = rows[Math.max(0, Math.min(rows.length - 1, i + d))]
    if (n) openMsg(n)
  }
  const openMsg = (m: Msg) => {
    if (m.is_draft) setCompose({ draft: m })
    else setParam('m', m.id)
  }
  const chip = (k: string, label: React.ReactNode, active: boolean, onClick: () => void) => (
    <button key={k} onClick={onClick} aria-pressed={active}
      className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
        active ? 'bg-brand-800 text-white ring-brand-800' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>{label}</button>
  )

  return (
    <div>
      <PageHeader icon="MessagesSquare" title="Messages" subtitle="Internal only — nothing here is sent to a patient. Departments and roles expand to their members when you send."
        actions={<Button variant="primary" icon="Send" onClick={() => setCompose({})}>New message</Button>} />
      <div className="grid min-h-[70vh] overflow-hidden rounded-xl border border-line bg-surface lg:grid-cols-[380px_1fr]">
        <div className={cn('flex min-w-0 flex-col border-line lg:border-r', selected && 'hidden lg:flex')}>
          <div className="space-y-2 border-b border-line p-3">
            <div className="flex flex-wrap gap-1">
              {FOLDERS.map((f) => {
                const n = f.key === 'inbox' ? counts.data?.unread : f.key === 'tasks' ? counts.data?.tasks_open : f.key === 'drafts' ? counts.data?.drafts : undefined
                return (
                  <button key={f.key} onClick={() => setParam('folder', f.key === 'inbox' ? null : f.key)}
                    className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium', folder === f.key ? 'bg-brand-800 text-white' : 'text-ink-2 hover:bg-surface-2')}>
                    <f.icon className="size-3.5" /> {f.label}{n ? <span className={cn('rounded-full px-1 text-[10px]', folder === f.key ? 'bg-white/20' : 'bg-surface-2 ring-1 ring-line')}>{n}</span> : null}
                  </button>
                )
              })}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
              <Input className="pl-8" placeholder="Search subject and text…" value={q} onChange={(e) => setQ(e.target.value)} data-list-search="" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chip('unread', 'Unread', flag('unread'), () => setParam('unread', flag('unread') ? null : '1'))}
              {chip('mentions', <><AtSign className="size-3" /> Mentions me</>, flag('mentions'), () => setParam('mentions', flag('mentions') ? null : '1'))}
              {chip('high', 'HIGH', prio === 'HIGH', () => setParam('priority', prio === 'HIGH' ? null : 'HIGH'))}
              {chip('urgent', 'URGENT', prio === 'URGENT', () => setParam('priority', prio === 'URGENT' ? null : 'URGENT'))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scroll-thin">
            {list.isLoading && <Spinner />}
            {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
            {list.data && rows.length === 0 && <Empty icon="Inbox" title="No messages" />}
            {rows.map((m) => <MessageRow key={m.id} m={m} folder={folder} active={m.id === selected} onClick={() => openMsg(m)} />)}
          </div>
          {list.data && list.data.total > rows.length && <div className="border-t border-line px-3 py-1.5 text-xs text-ink-3">Showing {rows.length} of {list.data.total}</div>}
        </div>
        <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
          {selected ? (
            <Thread id={selected} onClose={() => setParam('m', null)} onChanged={() => qc.invalidateQueries({ queryKey: ['messages'] })} />
          ) : (
            <div className="grid h-full place-items-center p-8">
              <Empty icon="Mail" title="Pick a conversation">
                Messages about an admitted patient also appear on that patient&apos;s IP chart; messages tagged with a UHID appear on the outpatient side.
              </Empty>
            </div>
          )}
        </div>
      </div>
      {compose && <Compose draft={compose.draft} onClose={() => setCompose(null)} onSent={(m) => { setCompose(null); if (m) setParam('m', m.id) }} />}
    </div>
  )
}

function MessageRow({ m, folder, active, onClick }: { m: Msg; folder: string; active: boolean; onClick: () => void }) {
  const unread = m.read === false
  return (
    <button onClick={onClick} className={cn('flex w-full gap-3 border-b border-line px-3 py-2.5 text-left', active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
      <Avatar name={folder === 'sent' || folder === 'drafts' ? m.audience?.[0]?.label ?? 'To' : m.sender_name} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate text-sm', unread ? 'font-semibold text-ink' : 'text-ink-2')}>
            {folder === 'sent' || folder === 'drafts' ? `To ${m.audience?.map((a) => a.label).join(', ') || '—'}` : m.sender_name}
          </span>
          {unread && <span className="size-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
          <span className="ml-auto shrink-0 text-[11px] text-ink-3">{ago(m.sent_at ?? m.created_at)}</span>
        </span>
        <span className={cn('block truncate text-sm', unread ? 'font-medium text-ink' : 'text-ink')}>{m.subject || '(no subject)'}</span>
        <span className="block truncate text-xs text-ink-3">{m.body_preview}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <PriorityBadge p={m.priority} />
          {m.type !== 'MESSAGE' && <Badge tone={TYPE_TONE[m.type]}>{m.type}</Badge>}
          {m.is_task && <Badge tone={m.task_status === 'Closed' ? 'green' : 'amber'}>{m.task_status === 'Closed' ? 'Task closed' : 'Task open'}</Badge>}
          {m.mentioned && <Badge tone="violet"><AtSign className="size-3" /> you</Badge>}
          {m.pinned && <Pin className="size-3 text-ink-3" />}
          {m.patient_label && <Badge tone="cyan">{m.encounter_label ?? m.patient_label}</Badge>}
          {m.is_draft && <Badge tone="gray">Draft</Badge>}
        </span>
      </span>
    </button>
  )
}

function Thread({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [reply, setReply] = useState('')
  const q = useQuery({ queryKey: ['messages', 'one', id], queryFn: () => api<{ message: Msg; thread: Msg[]; can_reply: boolean }>(`/messages/${id}`) })
  useEffect(() => { if (q.data) qc.invalidateQueries({ queryKey: ['messages', 'counts'] }) }, [q.data, qc])
  const state = useMutation({
    mutationFn: (b: { read?: boolean; pinned?: boolean; archived?: boolean }) => api(`/messages/${id}/state`, { method: 'POST', body: b }),
    onSuccess: (_, b) => { onChanged(); if (b.archived) { toast.success('Archived'); onClose() } else if (b.read === false) onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const task = useMutation({
    mutationFn: (action: 'convert' | 'close' | 'reopen') => api(`/messages/${id}/task`, { method: 'POST', body: { action } }),
    onSuccess: (_, a) => { toast.success(a === 'close' ? 'Task closed' : a === 'convert' ? 'Converted to a task' : 'Task reopened'); onChanged() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const send = useMutation({
    mutationFn: () => api(`/messages/${id}/reply`, { method: 'POST', body: { body: reply } }),
    onSuccess: () => { setReply(''); toast.success('Reply sent'); onChanged() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <Spinner />
  if (q.error) return <div className="p-4"><ErrorBox error={q.error} /></div>
  const m = q.data!.message
  const root = q.data!.thread[0] ?? m
  const isTask = q.data!.thread.find((t) => t.is_task)
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">{root.subject || '(no subject)'}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <PriorityBadge p={root.priority} />
            {root.type !== 'MESSAGE' && <Badge tone={TYPE_TONE[root.type]}>{root.type}</Badge>}
            {isTask && <Badge tone={isTask.task_status === 'Closed' ? 'green' : 'amber'}>{isTask.task_status === 'Closed' ? `Task closed by ${isTask.task_closed_by}` : 'Task open'}</Badge>}
            {m.patient_id && (
              <Link to={`/patients/${m.patient_id}`} className="inline-flex items-center gap-1 rounded-md bg-cyan-50 px-1.5 py-0.5 text-xs font-medium text-cyan-800 ring-1 ring-cyan-600/20 hover:underline dark:bg-cyan-500/10 dark:text-cyan-300">
                {m.patient_label}{m.encounter_label ? ` · ${m.encounter_label}` : ''}
              </Link>
            )}
            <span className="font-mono text-[11px] text-ink-3">{root.code}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {m.read !== undefined && (
            <>
              <Button size="xs" variant="ghost" onClick={() => state.mutate({ pinned: !m.pinned })} title={m.pinned ? 'Unpin' : 'Pin'}>{m.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}</Button>
              <Button size="xs" variant="ghost" onClick={() => state.mutate({ read: false })} title="Mark unread"><MailOpen className="size-4" /></Button>
              <Button size="xs" variant="ghost" onClick={() => state.mutate({ archived: !m.archived })} title={m.archived ? 'Move to inbox' : 'Archive'}>
                {m.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              </Button>
            </>
          )}
          {q.data!.can_reply && (isTask
            ? isTask.task_status === 'Closed'
              ? <Button size="xs" onClick={() => task.mutate('reopen')} loading={task.isPending}><CircleDot className="size-4" /> Reopen task</Button>
              : <Button size="xs" variant="success" onClick={() => task.mutate('close')} loading={task.isPending}><CheckCircle2 className="size-4" /> Close task</Button>
            : <Button size="xs" onClick={() => task.mutate('convert')} loading={task.isPending}><ListTodo className="size-4" /> Convert to task</Button>)}
          <Button size="xs" variant="ghost" className="lg:hidden" onClick={onClose} aria-label="Back to list"><X className="size-4" /></Button>
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 scroll-thin">
        {q.data!.thread.map((t) => (
          <article key={t.id} className={cn('rounded-xl border border-line p-3', t.sender_id === user?.id ? 'ml-6 bg-brand-50/50 dark:bg-brand-500/5' : 'mr-6 bg-surface')}>
            <header className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <Avatar name={t.sender_name} size="sm" />
              <span className="text-sm font-medium text-ink">{t.sender_name}</span>
              <span>{dateTime(t.sent_at ?? t.created_at)}</span>
              {t.recipients && t.recipients.length > 0 && (
                <span className="w-full pl-9">to {t.recipients.slice(0, 6).map((r) => `${r.name}${r.read_at ? ' ✓' : ''}`).join(', ')}{t.recipients.length > 6 ? ` +${t.recipients.length - 6}` : ''}
                  <span className="ml-1">({t.recipients.filter((r) => r.read_at).length}/{t.recipients.length} read)</span></span>
              )}
            </header>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{t.body}</p>
          </article>
        ))}
      </div>
      {q.data!.can_reply && (
        <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send.mutate() }}>
          <Textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to everyone in this conversation… (@username to mention)"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && reply.trim()) send.mutate() }} />
          <div className="mt-2 flex items-center justify-between text-xs text-ink-3">
            <span>⌘/Ctrl + Enter to send</span>
            <Button size="sm" variant="primary" type="submit" loading={send.isPending} disabled={!reply.trim()}><Send className="size-4" /> Reply</Button>
          </div>
        </form>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ compose

const KINDS = [{ key: 'people', label: 'People' }, { key: 'departments', label: 'Departments' }, { key: 'roles', label: 'Roles' }] as const

export function Compose({ draft, onClose, onSent, patientId, encounterId }: {
  draft?: Msg; onClose: () => void; onSent: (m?: Msg) => void; patientId?: string; encounterId?: string
}) {
  const qc = useQueryClient()
  const [to, setTo] = useState<Recipient[]>(draft?.audience ?? [])
  const [kind, setKind] = useState<'people' | 'departments' | 'roles'>('people')
  const [search, setSearch] = useState('')
  const ds = useDebounced(search, 200)
  const [subject, setSubject] = useState(draft?.subject ?? '')
  const [body, setBody] = useState(draft?.body ?? draft?.body_preview ?? '')
  const [priority, setPriority] = useState<Priority>(draft?.priority ?? 'NORMAL')
  const [type, setType] = useState<MsgType>(draft?.type ?? 'MESSAGE')
  const [isTask, setIsTask] = useState(draft?.is_task ?? false)
  const [about, setAbout] = useState<'ip' | 'op'>(draft?.encounter_id || encounterId ? 'ip' : 'op')
  const [encId, setEncId] = useState<string | null>(draft?.encounter_id ?? encounterId ?? null)
  const [patId, setPatId] = useState<string | null>(draft?.patient_id ?? patientId ?? null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const dir = useQuery({
    queryKey: ['messages', 'directory', kind, ds],
    queryFn: () => api<{ type: Recipient['type']; id: string; label: string; role_label?: string; designation?: string; members?: number; code?: string }[]>('/messages/directory', { query: { kind, q: ds } }),
    staleTime: 60_000,
  })
  const full = useQuery({ queryKey: ['messages', 'one', draft?.id], queryFn: () => api<{ message: Msg }>(`/messages/${draft!.id}`), enabled: !!draft?.id })
  useEffect(() => { if (full.data?.message.body) setBody(full.data.message.body) }, [full.data])
  const chosen = useMemo(() => new Set(to.map((r) => `${r.type}:${r.id}`)), [to])
  const payload = (asDraft: boolean) => ({
    to, subject, body, priority, type, is_task: isTask, draft: asDraft,
    patient_id: about === 'op' ? patId : undefined, encounter_id: about === 'ip' ? encId : undefined,
  })
  const save = useMutation({
    mutationFn: (asDraft: boolean) => draft?.id
      ? api<Msg>(`/messages/${draft.id}`, { method: 'PUT', body: payload(asDraft) })
      : api<Msg>('/messages', { method: 'POST', body: payload(asDraft) }),
    onSuccess: (m, asDraft) => {
      qc.invalidateQueries({ queryKey: ['messages'] })
      toast.success(asDraft ? 'Draft saved' : `Message sent${(m as Msg & { recipient_count?: number }).recipient_count ? ` to ${(m as Msg & { recipient_count?: number }).recipient_count} people` : ''}`)
      onSent(asDraft ? undefined : m)
    },
    onError: (e) => { if (e instanceof ApiError) setErrors(e.fieldErrors); toast.error(errorMessage(e)) },
  })
  const discard = useMutation({
    mutationFn: () => api(`/messages/${draft!.id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['messages'] }); toast.success('Draft discarded'); onClose() },
  })
  const seg = <T extends string>(opts: readonly T[], value: T, set: (v: T) => void) => (
    <div className="inline-flex flex-wrap gap-1">
      {opts.map((o) => (
        <button type="button" key={o} onClick={() => set(o)} aria-pressed={value === o}
          className={cn('rounded-md px-2 py-1 text-[11px] font-semibold ring-1 ring-inset', value === o ? 'bg-brand-800 text-white ring-brand-800' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>{o}</button>
      ))}
    </div>
  )
  return (
    <Modal open onClose={onClose} size="lg" title={<span className="flex items-center gap-2"><Send className="size-4" /> {draft ? 'Edit draft' : 'New message'}</span>}
      footer={<>
        {draft && <Button variant="ghost" className="mr-auto text-red-600" onClick={() => discard.mutate()} loading={discard.isPending}><Trash2 className="size-4" /> Discard</Button>}
        <Button onClick={() => save.mutate(true)} loading={save.isPending && save.variables === true} icon="Save">Save draft</Button>
        <Button variant="primary" onClick={() => save.mutate(false)} loading={save.isPending && save.variables === false} disabled={!to.length || !subject.trim() || !body.trim()}>
          <Send className="size-4" /> Send
        </Button>
      </>}>
      <p className="-mt-1 mb-3 text-xs text-ink-3">Departments and roles are expanded to their members when the message is sent.</p>
      <div className="space-y-3">
        <FieldWrap label="To" required error={errors.to}>
          {to.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {to.map((r) => (
                <span key={`${r.type}:${r.id}`} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs ring-1 ring-line">
                  <span className="text-ink-3">{r.type === 'user' ? '' : r.type === 'role' ? 'Role · ' : 'Dept · '}</span>{r.label}
                  <button type="button" onClick={() => setTo(to.filter((x) => !(x.type === r.type && x.id === r.id)))} aria-label={`Remove ${r.label}`}><X className="size-3" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input className="pl-8" value={search} placeholder={`Search ${kind}…`} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            {KINDS.map((k) => (
              <button type="button" key={k.key} onClick={() => setKind(k.key)}
                className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', kind === k.key ? 'bg-brand-800 text-white' : 'text-ink-2 hover:bg-surface-2')}>{k.label}</button>
            ))}
          </div>
          {(search || kind !== 'people') && (
            <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-line scroll-thin">
              {dir.isLoading && <div className="px-3 py-2 text-xs text-ink-3">Searching…</div>}
              {dir.data?.length === 0 && <div className="px-3 py-2 text-xs text-ink-3">No matches</div>}
              {dir.data?.map((d) => {
                const on = chosen.has(`${d.type}:${d.id}`)
                return (
                  <button type="button" key={d.id} disabled={on} onClick={() => { setTo([...to, { type: d.type, id: d.id, label: d.label }]); setSearch('') }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
                    <span className="flex-1 truncate text-ink">{d.label}</span>
                    <span className="text-xs text-ink-3">{d.type === 'user' ? [d.designation, d.role_label].filter(Boolean).join(' · ') : `${d.members ?? 0} members`}</span>
                  </button>
                )
              })}
            </div>
          )}
        </FieldWrap>
        <FieldWrap label="Subject" required error={errors.subject}><Input value={subject} maxLength={200} placeholder="What is this about?" onChange={(e) => setSubject(e.target.value)} /></FieldWrap>
        <div className="flex flex-wrap gap-6">
          <FieldWrap label="Priority">{seg(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const, priority, setPriority)}</FieldWrap>
          <FieldWrap label="Type">{seg(['MESSAGE', 'ALERT', 'NOTICE'] as const, type, setType)}</FieldWrap>
        </div>
        <FieldWrap label={<>About a patient <span className="font-normal text-ink-3">(optional)</span></>}>
          {about === 'ip'
            ? <RefPicker refName="ipd.admissions" value={encId} filter={{ status: 'Admitted' }} placeholder="IP number, name or UHID…" onChange={(id) => setEncId(id)} />
            : <RefPicker refName="registration.patients" value={patId} kind="patient" placeholder="UHID, name or mobile…" onChange={(id) => setPatId(id)} />}
          <div className="mt-1.5 flex gap-1">
            {(['ip', 'op'] as const).map((k) => (
              <button type="button" key={k} onClick={() => setAbout(k)}
                className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', about === k ? 'bg-brand-800 text-white' : 'text-ink-2 hover:bg-surface-2')}>
                {k === 'ip' ? 'Admitted (IP)' : 'Outpatient (UHID)'}
              </button>
            ))}
          </div>
        </FieldWrap>
        <FieldWrap label="Message" required error={errors.body}>
          <Textarea rows={5} value={body} placeholder="Write a message… (@username mentions a colleague)" onChange={(e) => setBody(e.target.value)} />
        </FieldWrap>
        <label className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-brand-700" checked={isTask} onChange={(e) => setIsTask(e.target.checked)} />
          This is a task somebody has to close
        </label>
      </div>
    </Modal>
  )
}

/**
 * Patient-tagged messages for charts (IP chart, OP EMR, Patient 360):
 *   <PatientMessages patientId={id} encounterId={admissionId} />
 * Lists messages about the patient (or that admission) and lets the user write a new one pre-tagged.
 */
export function PatientMessages({ patientId, encounterId, limit = 20 }: { patientId?: string; encounterId?: string; limit?: number }) {
  const [compose, setCompose] = useState(false)
  const query = { patient_id: patientId, encounter_id: encounterId, limit }
  const q = useQuery({ queryKey: ['messages', 'patient', query], queryFn: () => api<ListResp>('/messages', { query }), enabled: !!(patientId || encounterId) })
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-3">{q.data ? `${q.data.total} message${q.data.total === 1 ? '' : 's'} about this ${encounterId ? 'admission' : 'patient'}` : ''}</span>
        <Button size="xs" icon="Send" onClick={() => setCompose(true)}>New message</Button>
      </div>
      {q.isLoading && <Spinner />}
      {q.data?.rows.length === 0 && <Empty icon="MessagesSquare" title="No messages yet" />}
      {q.data?.rows.map((m) => (
        <Link key={m.id} to={`/messages?m=${m.id}`} className="block rounded-lg border border-line px-3 py-2 hover:bg-surface-2">
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <span className="font-medium text-ink">{m.sender_name}</span> {dateTime(m.sent_at ?? m.created_at)}
            <span className="ml-auto flex gap-1"><PriorityBadge p={m.priority} />{m.is_task && <Badge tone={m.task_status === 'Closed' ? 'green' : 'amber'}>{m.task_status === 'Closed' ? 'Task closed' : 'Task open'}</Badge>}</span>
          </div>
          <div className="truncate text-sm text-ink">{m.subject}</div>
          <div className="truncate text-xs text-ink-2">{m.body_preview}</div>
        </Link>
      ))}
      {compose && <Compose patientId={patientId} encounterId={encounterId} onClose={() => setCompose(false)} onSent={() => setCompose(false)} />}
    </div>
  )
}
