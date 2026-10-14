import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, Input, PageHeader, Select, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import type { AuditRow } from '@/lib/types'

const ACTIONS = ['', 'create', 'update', 'status', 'delete', 'print', 'export', 'break_glass', 'auth.login', 'auth.login_failed', 'patient.view', 'file.view', 'ai.', 'approval.decide']

export default function AdminAudit() {
  const { modules } = useRegistry()
  const [f, setF] = useState({ module: '', action: '', date_from: '', date_to: '' })
  const [page, setPage] = useState(1)
  const q = useQuery({
    queryKey: ['admin', 'audit', f, page],
    queryFn: () => api<{ rows: AuditRow[]; total: number }>('/audit', { query: { ...f, page, limit: 50 } }),
    placeholderData: (p) => p,
  })
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / 50))
  return (
    <div>
      <PageHeader icon="History" title="Audit trail" subtitle="Every create, edit, status change, override, print, export, sign-in and break-glass — immutable and searchable." />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select className="w-56" value={f.module} onChange={(e) => { setPage(1); setF({ ...f, module: e.target.value }) }}>
            <option value="">All modules</option>
            <option value="auth">Sign-in</option>
            {modules.map((m) => <option key={m.id} value={m.id}>{m.no}. {m.name}</option>)}
          </Select>
          <Select className="w-48" value={f.action} onChange={(e) => { setPage(1); setF({ ...f, action: e.target.value }) }}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a || 'All actions'}</option>)}
          </Select>
          <Input type="date" className="w-40" value={f.date_from} onChange={(e) => setF({ ...f, date_from: e.target.value })} aria-label="From" />
          <Input type="date" className="w-40" value={f.date_to} onChange={(e) => setF({ ...f, date_to: e.target.value ? `${e.target.value}T23:59:59` : '' })} aria-label="To" />
          <span className="ml-auto self-center text-xs text-ink-3">{q.data?.total ?? 0} events</span>
        </div>
        {q.isLoading ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['When', 'User', 'Action', 'Module', 'Record', 'Changes / note'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {q.data?.rows.map((a) => (
                  <tr key={a.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{dateTime(a.at)}</td>
                    <td className="px-3 py-1.5">{a.user_name}<div className="text-[11px] text-ink-3">{a.role}</div></td>
                    <td className="px-3 py-1.5"><Badge tone={a.action.includes('fail') || a.action === 'break_glass' || a.action === 'delete' ? 'red' : a.action === 'create' ? 'green' : 'gray'}>{a.action}</Badge></td>
                    <td className="px-3 py-1.5 text-xs">{a.module}{a.entity ? `.${a.entity}` : ''}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{a.record_code}</td>
                    <td className="max-w-md px-3 py-1.5 text-xs text-ink-2">
                      {a.note && <div className="italic">“{a.note}”</div>}
                      {a.action !== 'create' && a.after && Object.entries(a.after).slice(0, 4).map(([k, v]) => <div key={k} className="truncate"><span className="text-ink-3">{k}:</span> {JSON.stringify(a.before?.[k] ?? null)} → {JSON.stringify(v)}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2 text-xs text-ink-2">
          <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="size-4" /></Button>
          Page {page} / {pages}
          <Button size="xs" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="size-4" /></Button>
        </div>
      </Card>
    </div>
  )
}
