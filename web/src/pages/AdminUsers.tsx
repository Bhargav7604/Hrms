import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Avatar, Badge, Button, Card, FieldWrap, Input, Modal, PageHeader, Select, Spinner } from '@/components/ui'
import { SessionList } from '@/features/platform/Sessions'
import { api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { dateTime } from '@/lib/format'

interface UserRow {
  id: string; username: string; name: string; role: string; perm_role?: string | null; employee_id?: string; email?: string
  active: boolean; last_login_at?: string; branches?: string[]
}

export default function AdminUsers() {
  const meta = useMeta()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<UserRow> & { password?: string } | null>(null)
  const [roleFilter, setRoleFilter] = useState('')
  const [devices, setDevices] = useState<UserRow | null>(null)
  const branches = meta.data?.branches ?? []
  const list = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api<UserRow[]>('/admin/users', { query: { q } }) })
  const save = useMutation({
    mutationFn: () => edit?.id
      ? api(`/admin/users/${edit.id}`, { method: 'PUT', body: { ...edit, role: edit.perm_role || edit.role, password: edit.password || null } })
      : api('/admin/users', { method: 'POST', body: { ...edit, role: edit?.perm_role || edit?.role } }),
    onSuccess: () => { toast.success('User saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['admin', 'users'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const roles = meta.data?.roles ?? {}
  return (
    <div>
      <PageHeader icon="UsersRound" title="Users" subtitle="Accounts, roles and the branches each user may work in. Every sign-in and change is audited."
        actions={<>
          <Link to="/admin/roles" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">Roles & permissions</Link>
          <Button variant="primary" icon="UserPlus" onClick={() => setEdit({ role: 'front_office', active: true, branches: [] })}>New user</Button>
        </>} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" /><Input className="pl-8" placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} data-list-search="" /></div>
          <Select className="w-56" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
            <option value="">All roles</option>
            {Object.entries(roles).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <span className="ml-auto text-xs text-ink-3">{list.data?.length ?? 0} users</span>
        </div>
        {list.isLoading ? <Spinner /> : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['User', 'Username', 'Role', 'Branches', 'Last sign-in', 'Status', ''].map((h) => <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {list.data?.filter((u) => !roleFilter || (u.perm_role ?? u.role) === roleFilter).map((u) => (
                <tr key={u.id} className="border-t border-line">
                  <td className="px-4 py-2"><span className="flex items-center gap-2"><Avatar name={u.name} size="sm" />{u.name}</span></td>
                  <td className="px-4 py-2 font-mono text-xs">{u.username}</td>
                  <td className="px-4 py-2">
                    <Badge tone={u.perm_role ? 'violet' : 'cyan'}>{roles[u.perm_role ?? u.role] ?? u.perm_role ?? u.role}</Badge>
                    {u.perm_role && <span className="ml-1 text-[11px] text-ink-3">on {roles[u.role] ?? u.role}</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-2">{u.role === 'admin' ? 'All' : u.branches?.length ? u.branches.join(', ') : <span className="text-ink-3">Home branch</span>}</td>
                  <td className="px-4 py-2 text-xs text-ink-2">{dateTime(u.last_login_at)}</td>
                  <td className="px-4 py-2">{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Disabled</Badge>}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <Button size="xs" variant="ghost" onClick={() => setDevices(u)}>Devices</Button>
                    <Button size="xs" onClick={() => setEdit({ ...u })}>Edit</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>
      <Modal open={!!devices} onClose={() => setDevices(null)} title={`Signed-in devices · ${devices?.name ?? ''}`} size="lg">
        {devices && <SessionList userId={devices.id} />}
      </Modal>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.username}` : 'New user'}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldWrap label="Full name" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></FieldWrap>
            <FieldWrap label="Username" required><Input value={edit.username ?? ''} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></FieldWrap>
            <FieldWrap label="Role" required>
              <Select value={edit.perm_role ?? edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value, perm_role: null })}>{Object.entries(roles).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </FieldWrap>
            <FieldWrap label="Email"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></FieldWrap>
            <FieldWrap label="Linked employee" className="sm:col-span-2" help="Links the account to the HR record (enables 'me' defaults and self-service).">
              <RefPicker refName="employees.employees" value={edit.employee_id ?? null} onChange={(id) => setEdit({ ...edit, employee_id: id ?? undefined })} />
            </FieldWrap>
            <FieldWrap label={edit.id ? 'Reset password' : 'Password'} required={!edit.id} help="At least 8 characters">
              <Input type="password" autoComplete="new-password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
            </FieldWrap>
            {branches.length > 0 && (
              <FieldWrap label="Branches" className="sm:col-span-2" help={(edit.perm_role ?? edit.role) === 'admin' ? 'Administrators can open every branch.' : 'None ticked = the home branch only.'}>
                <div className="flex flex-wrap gap-1.5">
                  {branches.map((b) => {
                    const on = (edit.branches ?? []).includes(b.code)
                    return (
                      <button type="button" key={b.code} disabled={edit.role === 'admin'} onClick={() => setEdit({ ...edit, branches: on ? (edit.branches ?? []).filter((x) => x !== b.code) : [...(edit.branches ?? []), b.code] })}
                        className={`rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${on ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2'}`}>
                        {b.name} <span className="opacity-70">{b.code}</span>
                      </button>
                    )
                  })}
                </div>
              </FieldWrap>
            )}
            <FieldWrap label="Status">
              <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-700" checked={edit.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
            </FieldWrap>
          </div>
        )}
      </Modal>
    </div>
  )
}
