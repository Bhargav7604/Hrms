import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Card, Empty, ErrorBox, FieldWrap, Input, PageHeader, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useAuth, useRegistry } from '@/lib/auth'
import { ago, dateTime } from '@/lib/format'

export interface Session {
  id: string
  device: string
  browser?: string
  os?: string | null
  kind: 'Desktop' | 'Mobile' | 'Tablet'
  ip?: string | null
  branch_id?: string | null
  created_at: string
  last_active_at?: string | null
  expires_at: string
  current: boolean
}

const KIND_ICON = { Desktop: Monitor, Mobile: Smartphone, Tablet }

/** Signed-in devices with remote sign-out. `userId` (admin) shows another user's devices. */
export function SessionList({ userId }: { userId?: string }) {
  const qc = useQueryClient()
  const { logout } = useAuth()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ['sessions', userId ?? 'me'],
    queryFn: () => api<{ sessions: Session[]; limit: number }>('/auth/sessions', { query: { user_id: userId } }),
  })
  const revoke = useMutation({
    mutationFn: (s: Session) => api(`/auth/sessions/${s.id}/revoke`, { method: 'POST' }),
    onSuccess: (_, s) => {
      if (s.current) { toast.success('Signed out'); logout().then(() => nav('/login')); return }
      toast.success(`${s.device} signed out`)
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const others = useMutation({
    mutationFn: () => api<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' }),
    onSuccess: (r) => { toast.success(`${r.revoked} other device${r.revoked === 1 ? '' : 's'} signed out`); qc.invalidateQueries({ queryKey: ['sessions'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  const rows = q.data?.sessions ?? []
  return (
    <div className="space-y-3">
      {!userId && (
        <p className="text-sm text-ink-2">
          {q.data?.limit ? <>You can be signed in on up to <b>{q.data.limit}</b> device{q.data.limit === 1 ? '' : 's'} at a time — signing in on another device signs out the one used least recently.</>
            : <>There is no limit on how many devices you can be signed in on.</>}
        </p>
      )}
      {rows.length === 0 && <Empty icon="MonitorX" title="No active sessions" />}
      {rows.map((s) => {
        const K = KIND_ICON[s.kind] ?? Monitor
        return (
          <div key={s.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface p-4">
            <div className="grid size-11 place-items-center rounded-xl bg-surface-2 text-ink-2 ring-1 ring-line"><K className="size-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{s.device}</span>
                {s.current && <Badge tone="green"><ShieldCheck className="size-3" /> This device</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-ink-2">IP {s.ip ?? '—'}{s.branch_id ? ` · branch ${s.branch_id}` : ''}</div>
              <div className="mt-0.5 text-xs text-ink-3">
                Signed in {dateTime(s.created_at)} · last active {s.last_active_at ? `${dateTime(s.last_active_at)} (${ago(s.last_active_at)})` : '—'}
              </div>
            </div>
            <Button size="sm" variant={s.current ? 'secondary' : 'danger'} icon="LogOut" loading={revoke.isPending && revoke.variables?.id === s.id}
              onClick={() => { if (s.current || confirm(`Sign out ${s.device}? Anyone using it will have to sign in again.`)) revoke.mutate(s) }}>
              Sign out
            </Button>
          </div>
        )
      })}
      {!userId && rows.filter((r) => !r.current).length > 0 && (
        <Button size="sm" variant="ghost" className="text-red-600" loading={others.isPending} onClick={() => { if (confirm('Sign out every other device?')) others.mutate() }}>
          Sign out all other devices
        </Button>
      )}
    </div>
  )
}

function SessionLimit() {
  const qc = useQueryClient()
  const setting = useQuery({ queryKey: ['settings', 'security'], queryFn: () => api<{ values: { max_concurrent_sessions?: number } }>('/settings/security') })
  const [v, setV] = useState<string | null>(null)
  const cur = setting.data?.values.max_concurrent_sessions
  const save = useMutation({
    mutationFn: () => api('/settings/security', { method: 'PUT', body: { scope: 'org', values: { max_concurrent_sessions: v === '' ? null : Number(v) } } }),
    onSuccess: () => { toast.success('Session limit saved'); setV(null); qc.invalidateQueries({ queryKey: ['settings', 'security'] }); qc.invalidateQueries({ queryKey: ['sessions'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Card title="Concurrent sign-ins (organisation)" icon="ShieldCheck" className="mt-6">
      <div className="flex flex-wrap items-end gap-3">
        <FieldWrap label="Devices per user" help="0 = unlimited. Empty = the default (2). Applies at the next sign-in." className="w-64">
          <Input type="number" min={0} max={20} value={v ?? (cur ?? '')} placeholder="2" onChange={(e) => setV(e.target.value)} />
        </FieldWrap>
        <Button variant="primary" disabled={v === null} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </Card>
  )
}

export default function Sessions() {
  const nav = useNavigate()
  const reg = useRegistry()
  return (
    <div className="max-w-3xl">
      <button onClick={() => nav(-1)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"><ArrowLeft className="size-4" /> Back</button>
      <PageHeader icon="MonitorSmartphone" title="Devices & sessions" chrome={false}
        subtitle="Devices currently signed in to your account. Sign out any you do not recognise — and change your password." />
      <SessionList />
      {reg.meta?.user.role === 'admin' && <SessionLimit />}
    </div>
  )
}
