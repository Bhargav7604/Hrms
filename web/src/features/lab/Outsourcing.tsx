import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, Empty, ErrorBox, FieldWrap, Input, Modal, Select, Spinner, StatusBadge, Switch, Tabs, Textarea } from '@/components/ui'
import { api, errorMessage, uploadFile } from '@/lib/api'
import { date, dateTime } from '@/lib/format'
import { PriorityBadge, type OrderDetail } from '@/pages/bespoke/lab-worklist'
import { ExternalReportLink } from './reportview'
import { Kpi, LabShell, useLabAccess } from './shell'
import type { LabRow } from './types'

interface SendOut {
  id: string; code: string; status: string; order: string; manifest_no?: string | null; dispatched_at?: string | null; courier?: string | null
  docket_no?: string | null; expected_by?: string | null; received_at?: string | null; external_ref?: string | null; report_file?: string | null
  cost?: number | null; sample_barcode?: string | null; order_code?: string | null; test_name?: string | null; lab?: string | null
  created_at?: string | null; patient?: { name: string; uhid?: string | null } | null; overdue: boolean
}
interface Res { candidates: (LabRow & { suggested_lab?: string | null })[]; others: LabRow[]; rows: SendOut[]
  labs: { id: string; name: string; turnaround_days?: number | null; accreditation?: string | null }[]; counts: Record<string, number> }
type Tab = 'send' | 'transit' | 'received' | 'all'

export default function OutSourcing() {
  const acc = useLabAccess()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('send')
  const [showAll, setShowAll] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [form, setForm] = useState({ reference_lab: '', courier: '', docket_no: '', expected_by: '', dispatch_now: true })
  const [dispatching, setDispatching] = useState<SendOut | null>(null)
  const [receiving, setReceiving] = useState<SendOut | null>(null)
  const list = useQuery({ queryKey: ['x', 'lab', 'outsourcing'], queryFn: () => api<Res>('/lab/outsourcing') })
  const done = () => { qc.invalidateQueries({ queryKey: ['x', 'lab'] }); qc.invalidateQueries({ queryKey: ['x', 'orders'] }) }
  const send = useMutation({
    mutationFn: () => api<{ manifest_no: string; send_outs: unknown[]; expected_by: string }>('/lab/outsourcing', {
      method: 'POST', body: { order_ids: [...sel], reference_lab: form.reference_lab, courier: form.courier || undefined, docket_no: form.docket_no || undefined,
        expected_by: form.expected_by || undefined, dispatch_now: form.dispatch_now },
    }),
    onSuccess: (r) => { toast.success(`Manifest ${r.manifest_no}: ${r.send_outs.length} sample(s) ${form.dispatch_now ? 'dispatched' : 'queued'} · report expected ${date(r.expected_by)}`); setSel(new Set()); done() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const cand = useMemo(() => (showAll ? [...(list.data?.candidates ?? []), ...(list.data?.others ?? [])] : list.data?.candidates ?? []), [list.data, showAll])
  const rows = (list.data?.rows ?? []).filter((r) => tab === 'all' || (tab === 'transit' ? ['To dispatch', 'Dispatched'].includes(r.status) : tab === 'received' ? r.status === 'Report received' : false))
  const c = list.data?.counts ?? {}
  const pickLab = (id: string) => setForm((f) => ({ ...f, reference_lab: id }))
  const suggested = cand.find((x) => sel.has(x.id) && 'suggested_lab' in x && x.suggested_lab)
  return (
    <LabShell screen="outsourcing" icon="Truck" title="Out-sourcing"
      subtitle="Send samples for tests done outside to a reference lab with a manifest and docket, track dispatch and due dates, and receive the external report into the patient's result for authorisation."
      actions={<div className="flex gap-2"><Kpi icon="PackageOpen" label="To dispatch" value={c['To dispatch'] ?? 0} /><Kpi icon="Truck" label="At reference lab" value={c.Dispatched ?? 0} /><Kpi icon="AlarmClock" label="Report overdue" value={c.overdue ?? 0} tone={c.overdue ? 'alert' : undefined} /></div>}>
      <Tabs className="mb-3" value={tab} onChange={setTab} tabs={[
        { key: 'send', label: 'To send', count: list.data?.candidates.length },
        { key: 'transit', label: 'Sent', count: (c['To dispatch'] ?? 0) + (c.Dispatched ?? 0) },
        { key: 'received', label: 'Reports received', count: c['Report received'] ?? 0 },
        { key: 'all', label: 'All' },
      ]} />
      {list.isLoading && <Spinner />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data && tab === 'send' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card pad={false} title="Collected samples" actions={<label className="flex items-center gap-2 text-xs text-ink-2"><Switch size="sm" checked={showAll} onChange={setShowAll} label="Show all tests" />Show tests done in-house too</label>}>
            {cand.length === 0 ? <Empty icon="Truck" title="No samples waiting to be sent out">Tests marked “outsourced” in the catalogue appear here once collected.</Empty> : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-xs text-ink-2"><tr>{acc.benchEdit && <th className="w-8 px-3 py-2" />}{['Priority', 'Test', 'Patient', 'Barcode', 'Collected', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
                  <tbody>{cand.map((x) => (
                    <tr key={x.id} className="border-t border-line">
                      {acc.benchEdit && <td className="px-3 py-2"><input type="checkbox" className="size-4 accent-brand-700" checked={sel.has(x.id)} aria-label={`Select ${x.code}`}
                        onChange={(e) => { setSel((cur) => { const n = new Set(cur); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n }); const lab = (x as { suggested_lab?: string | null }).suggested_lab; if (e.target.checked && lab && !form.reference_lab) pickLab(lab) }} /></td>}
                      <td className="px-3 py-2"><PriorityBadge priority={x.priority} /></td>
                      <td className="px-3 py-2 text-ink">{x.test.name}<div className="text-xs text-ink-3">{x.test.sample_type}</div></td>
                      <td className="px-3 py-2 text-ink">{x.patient.name}<div className="text-xs text-ink-3">{x.patient.uhid}</div></td>
                      <td className="px-3 py-2 font-mono text-xs">{x.sample_barcode}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(x.collected_at)}</td>
                      <td className="px-3 py-2"><StatusBadge status={x.status} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
          {acc.benchEdit && (
            <Card title={`Send ${sel.size || ''} sample${sel.size === 1 ? '' : 's'}`}>
              <div className="space-y-3">
                <FieldWrap label="Reference lab" required help={suggested ? 'Pre-selected from the test catalogue' : undefined}>
                  <Select value={form.reference_lab} onChange={(e) => pickLab(e.target.value)}>
                    <option value="">Choose…</option>{list.data.labs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.turnaround_days ? ` · ${l.turnaround_days} d` : ''}</option>)}
                  </Select>
                </FieldWrap>
                {list.data.labs.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">Add reference labs in Lab setup first.</p>}
                <div className="grid grid-cols-2 gap-2">
                  <FieldWrap label="Courier"><Input value={form.courier} onChange={(e) => setForm({ ...form, courier: e.target.value })} placeholder="Hospital courier" /></FieldWrap>
                  <FieldWrap label="Docket / AWB"><Input value={form.docket_no} onChange={(e) => setForm({ ...form, docket_no: e.target.value })} /></FieldWrap>
                </div>
                <FieldWrap label="Report expected by" help="Blank = the lab's turnaround"><Input type="date" value={form.expected_by} onChange={(e) => setForm({ ...form, expected_by: e.target.value })} /></FieldWrap>
                <label className="flex items-center gap-2 text-sm text-ink"><Switch checked={form.dispatch_now} onChange={(v) => setForm({ ...form, dispatch_now: v })} label="Dispatch now" />Dispatched now (else queued for pickup)</label>
                <Button variant="primary" icon="Truck" className="w-full" disabled={!sel.size || !form.reference_lab} loading={send.isPending} onClick={() => send.mutate()}>Create manifest</Button>
              </div>
            </Card>
          )}
        </div>
      )}
      {list.data && tab !== 'send' && (
        <Card pad={false}>
          {rows.length === 0 ? <Empty icon="Inbox" title="Nothing here" /> : (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['Send-out', 'Test', 'Patient', 'Reference lab', 'Manifest / docket', 'Dispatched', 'Expected', 'Status', ''].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.code}<div className="text-ink-3">{r.order_code}</div></td>
                    <td className="px-3 py-2 text-ink">{r.test_name}<div className="font-mono text-xs text-ink-3">{r.sample_barcode}</div></td>
                    <td className="px-3 py-2 text-ink">{r.patient?.name}<div className="text-xs text-ink-3">{r.patient?.uhid}</div></td>
                    <td className="px-3 py-2 text-ink">{r.lab}</td>
                    <td className="px-3 py-2 text-xs text-ink-2">{r.manifest_no}<div>{[r.courier, r.docket_no].filter(Boolean).join(' · ')}</div></td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(r.dispatched_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{r.overdue ? <Badge tone="red">{date(r.expected_by)} · overdue</Badge> : <span className="text-ink-2">{date(r.expected_by)}</span>}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} />{r.report_file && <div className="mt-0.5"><ExternalReportLink fileId={r.report_file} /></div>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {acc.benchEdit && r.status === 'To dispatch' && <Button size="xs" onClick={() => setDispatching(r)}>Dispatch</Button>}
                      {acc.benchEdit && ['To dispatch', 'Dispatched'].includes(r.status) && <Button size="xs" variant="primary" className="ml-1" onClick={() => setReceiving(r)}>Receive report</Button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {dispatching && <DispatchDialog so={dispatching} onClose={() => setDispatching(null)} onDone={done} />}
      {receiving && <ReceiveDialog so={receiving} onClose={() => setReceiving(null)} onDone={done} />}
    </LabShell>
  )
}

function DispatchDialog({ so, onClose, onDone }: { so: SendOut; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ courier: so.courier ?? '', docket_no: so.docket_no ?? '', expected_by: so.expected_by ?? '' })
  const m = useMutation({
    mutationFn: () => api(`/lab/outsourcing/${so.id}/dispatch`, { method: 'POST', body: { courier: f.courier || undefined, docket_no: f.docket_no || undefined, expected_by: f.expected_by || undefined } }),
    onSuccess: () => { toast.success(`${so.code} dispatched`); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={`Dispatch ${so.test_name}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Dispatch</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Courier"><Input value={f.courier} onChange={(e) => setF({ ...f, courier: e.target.value })} /></FieldWrap>
        <FieldWrap label="Docket / AWB"><Input value={f.docket_no} onChange={(e) => setF({ ...f, docket_no: e.target.value })} /></FieldWrap>
        <FieldWrap label="Report expected by"><Input type="date" value={f.expected_by} onChange={(e) => setF({ ...f, expected_by: e.target.value })} /></FieldWrap>
      </div>
    </Modal>
  )
}

function ReceiveDialog({ so, onClose, onDone }: { so: SendOut; onClose: () => void; onDone: () => void }) {
  const det = useQuery({ queryKey: ['x', 'orders', 'detail', so.order], queryFn: () => api<OrderDetail>(`/orders/${so.order}/detail`) })
  const [vals, setVals] = useState<Record<string, string>>({})
  const [ext, setExt] = useState('')
  const [text, setText] = useState('')
  const [cost, setCost] = useState('')
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const m = useMutation({
    mutationFn: () => api(`/lab/outsourcing/${so.id}/receive`, {
      method: 'POST', body: { external_ref: ext || undefined, report_file: file?.id, result: text || undefined, cost: cost ? Number(cost) : undefined,
        values: Object.entries(vals).filter(([, v]) => v.trim()).map(([parameter, value]) => ({ parameter, value: value.trim() })) },
    }),
    onSuccess: () => { toast.success('Report received — the result is waiting for authorisation on the worksheet'); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const any = Object.values(vals).some((v) => v.trim()) || text.trim() || file
  return (
    <Modal open onClose={onClose} size="lg" title={`Reference lab report · ${so.test_name} · ${so.patient?.name ?? ''}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!any || uploading} loading={m.isPending} onClick={() => m.mutate()}>Receive & result</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <FieldWrap label="Reference lab accession no."><Input value={ext} onChange={(e) => setExt(e.target.value)} /></FieldWrap>
          <FieldWrap label="Charge by reference lab (₹)"><Input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} /></FieldWrap>
          <FieldWrap label="Report (PDF / image)">
            <Input type="file" accept="application/pdf,image/*" onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setUploading(true)
              try { const up = await uploadFile(f); setFile({ id: up.id, name: up.name }) } catch (err) { toast.error(errorMessage(err)) } finally { setUploading(false) }
            }} />
            {file && <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">Attached {file.name}</p>}
          </FieldWrap>
        </div>
        {det.isLoading ? <Spinner /> : det.data && det.data.parameters.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-3"><tr><th className="text-left">Parameter</th><th className="text-left">Result</th><th className="text-left">Unit</th><th className="text-left">Reference</th></tr></thead>
            <tbody>{det.data.parameters.map((p) => (
              <tr key={p.parameter} className="border-t border-line">
                <td className="py-1 text-ink">{p.parameter}</td>
                <td className="py-1"><Input className="h-8 w-32" value={vals[p.parameter] ?? ''} onChange={(e) => setVals({ ...vals, [p.parameter]: e.target.value })} aria-label={p.parameter} /></td>
                <td className="py-1 text-ink-2">{p.unit}</td><td className="py-1 text-ink-2">{p.ref_range}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <FieldWrap label="Report text / comments" help="Enter values, text or attach the report — at least one"><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></FieldWrap>
      </div>
    </Modal>
  )
}
