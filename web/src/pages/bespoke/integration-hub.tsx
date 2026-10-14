import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Copy, Download, Search } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { EntityView, useEntity } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Spinner, Tabs, Textarea, type BadgeTone } from '@/components/ui'
import { api, apiUrl, errorMessage, getToken } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, number, todayISO } from '@/lib/format'
import type { ListResult, Rec } from '@/lib/types'
import type { BespokeProps } from './index'

interface ConnectorStatus {
  id: string | null; code?: string; name: string; type: string; direction: string; transport?: string; environment?: string; status: string
  health: string; last_error?: string | null; last_24h: number; failed_24h: number; inbound_24h: number; outbound_24h: number; total: number
  last_message_at: string | null
}
type Tab = 'status' | 'fhir' | 'hl7' | 'abha' | 'tally' | 'log'
const HEALTH: Record<string, BadgeTone> = { Healthy: 'green', Idle: 'gray', Degraded: 'amber', Error: 'red', Disabled: 'gray' }
const auth = () => ({ Authorization: `Bearer ${getToken() ?? ''}` })

// ------------------------------------------------------------------ status

function StatusCards() {
  const q = useQuery({ queryKey: ['x', 'connectors', 'status'], queryFn: () => api<{ connectors: ConnectorStatus[]; mode: string }>('/integrations/status'), refetchInterval: 30_000 })
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  const rows = q.data!.connectors
  if (!rows.length) return <Empty icon="Plug" title="No connectors yet">Connectors register themselves on first use (FHIR read, HL7 result, ABHA, TPA, Tally).</Empty>
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-2">Transport mode: <b>{q.data!.mode}</b> — outbound messages are generated, validated and logged; live gateways plug in per connector.</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((c) => {
          const DirIcon = c.direction === 'Inbound' ? ArrowDownLeft : c.direction === 'Outbound' ? ArrowUpRight : ArrowLeftRight
          return (
            <section key={c.id ?? c.name} className={cn('rounded-xl border bg-surface p-3', c.health === 'Error' ? 'border-red-300 dark:border-red-500/40' : 'border-line')}>
              <header className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-ink">{c.name}</h3>
                  <p className="flex items-center gap-1 text-xs text-ink-2"><DirIcon className="size-3.5" /> {c.type} · {c.direction}{c.environment ? ` · ${c.environment}` : ''}</p>
                </div>
                <Badge tone={HEALTH[c.health] ?? 'gray'} dot>{c.health}</Badge>
              </header>
              <dl className="mt-2 grid grid-cols-4 gap-2 text-center">
                {([['24 h', c.last_24h], ['In', c.inbound_24h], ['Out', c.outbound_24h], ['Failed', c.failed_24h]] as const).map(([l, v]) => (
                  <div key={l} className="rounded-lg bg-surface-2 py-1.5">
                    <dt className="text-[11px] text-ink-3">{l}</dt>
                    <dd className={cn('text-base font-semibold tabular', l === 'Failed' && v ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{number(v)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-ink-3">Last message {c.last_message_at ? ago(c.last_message_at) : 'never'} · {number(c.total)} total{c.transport ? ` · ${c.transport}` : ''}</p>
              {c.last_error && <p className="mt-1 truncate text-xs text-red-700 dark:text-red-300" title={c.last_error}>Last error: {c.last_error}</p>}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ FHIR explorer

async function fhirGet(path: string, query?: Record<string, string>): Promise<Rec> {
  const res = await fetch(apiUrl(`/fhir${path}`, query), { headers: { ...auth(), Accept: 'application/fhir+json' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.issue?.[0]?.diagnostics ?? body?.message ?? res.statusText)
  return body
}

function JsonBox({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2)
  return (
    <div className="relative">
      <Button size="xs" variant="secondary" className="absolute right-2 top-2" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success('Copied'))}>
        <Copy className="size-3.5" /> Copy
      </Button>
      <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink scroll-thin">{text}</pre>
    </div>
  )
}

const RESOURCES: { key: string; label: string; path: string; query?: Record<string, string> }[] = [
  { key: 'patient', label: 'Patient', path: '/Patient/{id}' },
  { key: 'enc', label: 'Encounters', path: '/Encounter' },
  { key: 'vitals', label: 'Vital signs', path: '/Observation', query: { category: 'vital-signs' } },
  { key: 'lab', label: 'Lab observations', path: '/Observation', query: { category: 'laboratory' } },
  { key: 'reports', label: 'Diagnostic reports', path: '/DiagnosticReport' },
  { key: 'meds', label: 'Medication requests', path: '/MedicationRequest' },
]

function FhirExplorer() {
  const [ident, setIdent] = useState('')
  const [patient, setPatient] = useState<Rec | null>(null)
  const [res, setRes] = useState('patient')
  const find = useMutation({
    mutationFn: async () => {
      const raw = ident.trim()
      const digits = raw.replace(/\D/g, '')
      const identifier = digits.length === 14 && !/^uh/i.test(raw) ? `https://healthid.ndhm.gov.in|${raw}` : `https://vlack.health/uhid|${raw}`
      const b = await fhirGet('/Patient', { identifier })
      if (!b.total) throw new Error(`No patient with identifier ${raw}`)
      return b.entry[0].resource as Rec
    },
    onSuccess: (p) => { setPatient(p); setRes('patient') },
    onError: (e) => { setPatient(null); toast.error(errorMessage(e)) },
  })
  const spec = RESOURCES.find((r) => r.key === res)!
  const data = useQuery({
    queryKey: ['x', 'connectors', 'fhir', patient?.id, res],
    queryFn: () => (spec.key === 'patient' ? fhirGet(`/Patient/${patient!.id}`) : fhirGet(spec.path, { patient: patient!.id, ...(spec.query ?? {}) })),
    enabled: !!patient,
  })
  return (
    <div className="space-y-3">
      <Card title="FHIR R4 explorer" icon="Braces">
        <p className="mb-3 text-xs text-ink-2">Read-only FHIR R4 API at <code className="rounded bg-surface-2 px-1">/api/fhir</code> (CapabilityStatement at <code className="rounded bg-surface-2 px-1">/api/fhir/metadata</code>). Every read is audited and logged.</p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ident.trim()) find.mutate() }}>
          <FieldWrap label="UHID or ABHA number" className="w-72">
            <Input value={ident} onChange={(e) => setIdent(e.target.value)} placeholder="UH00000050 or 91-1234-5678-9012" autoFocus />
          </FieldWrap>
          <Button type="submit" variant="primary" loading={find.isPending} disabled={!ident.trim()}><Search className="size-4" /> Find patient</Button>
        </form>
      </Card>
      {patient && (
        <Card pad={false} title={<span>{(patient.name as Rec[])?.[0]?.text} <span className="font-mono text-xs text-ink-3">Patient/{patient.id}</span></span>}>
          <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2">
            {RESOURCES.map((r) => (
              <button key={r.key} type="button" onClick={() => setRes(r.key)}
                className={cn('rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset', res === r.key ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
                {r.label}
              </button>
            ))}
            {data.data?.resourceType === 'Bundle' && <Badge tone="blue" className="ml-auto">Bundle · {data.data.total} resources</Badge>}
          </div>
          <div className="p-4">
            {data.isLoading && <Spinner />}
            {data.error && <ErrorBox error={data.error} />}
            {data.data && <JsonBox value={data.data} />}
          </div>
        </Card>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ HL7 console

function ackCode(ack: string) {
  return /(?:^|\r|\n)MSA\|(AA|AE|AR|CA|CE|CR)/.exec(ack)?.[1] ?? null
}

function Hl7Console() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const allowed = ['lab', 'radiology', 'admin'].includes(user?.role ?? '')
  const [msg, setMsg] = useState('')
  const [ack, setAck] = useState<string | null>(null)
  const sample = useMutation({
    mutationFn: async () => {
      const list = await api<ListResult>('/m/orders/orders', { query: { status: 'Ordered', f_category: 'LAB', limit: 1, sort: '-ordered_at' } })
      const o = list.rows[0]
      if (!o) throw new Error('No pending lab order to build a sample from')
      const uhid = (list.refs[o.patient_id ?? ''] ?? '').split(' · ').pop() ?? ''
      const svc = (await api<Rec[]>('/lookup/billing/services', { query: { ids: o.service_id } }))[0] as Rec | undefined
      const params = ((svc?.parameters as Rec[] | undefined) ?? []).slice(0, 6)
      const ts = new Date()
      const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}`
      const obx = params.length ? params.map((p, i) => {
        const lo = Number(p.ref_low ?? 0), hi = Number(p.ref_high ?? 0)
        const value = p.ref_low != null && p.ref_high != null ? +(lo + (hi - lo) * 0.55).toFixed(1) : 'Negative'
        return `OBX|${i + 1}|${typeof value === 'number' ? 'NM' : 'ST'}|${i + 1}^${p.parameter}||${value}|${p.unit ?? ''}|${p.ref_low ?? ''}-${p.ref_high ?? ''}|N|||F`
      }) : ['OBX|1|ST|1^Result||See report||||||F']
      return [
        `MSH|^~\\&|ANALYSER|VLACK-LAB|VLACK-HIS|VLACK|${stamp}||ORU^R01|T${stamp}|P|2.5.1`,
        `PID|1||${uhid}^^^VLACK^MR`,
        `OBR|1|${o.code}|S${stamp}|${svc?.code ?? ''}^${svc?.name ?? svc?.title ?? 'Test'}|||${stamp}|||||||||||||||${stamp}|||F`,
        ...obx,
      ].join('\n')
    },
    onSuccess: (m) => { setMsg(m); setAck(null) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl('/hl7/oru'), { method: 'POST', headers: { ...auth(), 'Content-Type': 'text/plain' }, body: msg.replace(/\r?\n/g, '\r') })
      const text = await res.text()
      if (!res.ok) {
        let message = text
        try { message = JSON.parse(text).message ?? text } catch { /* plain-text error body */ }
        throw new Error(message)
      }
      return text
    },
    onSuccess: (a) => {
      setAck(a)
      const code = ackCode(a)
      if (code === 'AA') toast.success('Accepted (AA) — results filed to the order')
      else toast.error(`Acknowledged with ${code ?? 'unknown'} — see ACK`)
      qc.invalidateQueries({ queryKey: ['x', 'connectors'] })
      qc.invalidateQueries({ queryKey: ['m', 'connectors'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const code = ack ? ackCode(ack) : null
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card title="HL7 v2 test console (ORU^R01)" icon="TerminalSquare"
        actions={<Button size="xs" variant="secondary" loading={sample.isPending} onClick={() => sample.mutate()}>Sample from a pending order</Button>}>
        <p className="mb-2 text-xs text-ink-2">Paste a pipe-delimited result message from an analyser or middleware. OBR-2 (placer) must be our order number;
          PID-3 is checked against the order's UHID; flags are re-derived from the test master's reference and critical limits.</p>
        <Textarea rows={14} value={msg} onChange={(e) => setMsg(e.target.value)} className="font-mono text-[11px]" spellCheck={false}
          placeholder={'MSH|^~\\&|ANALYSER|LAB|VLACK-HIS|VLACK|20261013171500||ORU^R01|MSG001|P|2.5.1\nPID|1||UH00000050\nOBR|1|ORD-000123|...\nOBX|1|NM|K^Potassium||4.2|mmol/L|3.5-5.1|N|||F'} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-ink-3">{allowed ? 'Posts to /api/hl7/oru as your user (audited).' : 'Only lab, radiology or admin users can file results.'}</span>
          <Button variant="primary" icon="Send" disabled={!allowed || !msg.trim()} loading={send.isPending} onClick={() => send.mutate()}>Send message</Button>
        </div>
      </Card>
      <Card title="Acknowledgement" icon="MailCheck" actions={code && <Badge tone={code === 'AA' ? 'green' : code === 'AE' ? 'amber' : 'red'}>{code === 'AA' ? 'AA · accepted' : code === 'AE' ? 'AE · application error' : `${code} · rejected`}</Badge>}>
        {ack ? <pre className="overflow-auto whitespace-pre rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-ink">{ack.replace(/\r/g, '\n')}</pre>
          : <Empty icon="MailQuestion" title="No message sent yet">The ACK (MSA / ERR segments) appears here; every message is kept in the message log.</Empty>}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ ABHA

function AbhaVerify() {
  const qc = useQueryClient()
  const [pid, setPid] = useState<string | null>(null)
  const [abha, setAbha] = useState('')
  const [result, setResult] = useState<Rec | null>(null)
  const digits = abha.replace(/\D/g, '')
  const fmt = (d: string) => [d.slice(0, 2), d.slice(2, 6), d.slice(6, 10), d.slice(10, 14)].filter(Boolean).join('-')
  const verify = useMutation({
    mutationFn: () => api<Rec>('/abdm/abha/verify', { method: 'POST', body: { patient_id: pid, abha_number: fmt(digits) } }),
    onSuccess: (r) => { setResult(r); toast.success(`ABHA ${r.abha_number} linked to ${r.patient.code}`); qc.invalidateQueries({ queryKey: ['x', 'connectors'] }) },
    onError: (e) => { setResult(null); toast.error(errorMessage(e)) },
  })
  return (
    <Card title="Verify & link ABHA (ABDM)" icon="BadgeCheck" className="max-w-2xl">
      <p className="mb-3 text-xs text-ink-2">Sandbox mode validates the 14-digit ABHA number and links it to the patient; with ABDM gateway credentials the same
        call verifies against the ABHA registry. The number is stored on the patient and exposed as the FHIR ABHA identifier.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Patient" required>
          <RefPicker refName="registration.patients" kind="patient" value={pid} onChange={(id) => { setPid(id); setResult(null) }} placeholder="Name, UHID or mobile…" />
        </FieldWrap>
        <FieldWrap label="ABHA number" required help={digits.length && digits.length !== 14 ? `${digits.length}/14 digits` : 'XX-XXXX-XXXX-XXXX'}>
          <Input value={fmt(digits)} inputMode="numeric" onChange={(e) => setAbha(e.target.value.replace(/\D/g, '').slice(0, 14))} placeholder="91-1234-5678-9012"
            invalid={!!digits.length && digits.length !== 14} />
        </FieldWrap>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        {result ? <Badge tone="green">Verified ({result.mode}) · {result.abha_number} → {result.patient.code}</Badge> : <span />}
        <Button variant="primary" disabled={!pid || digits.length !== 14} loading={verify.isPending} onClick={() => verify.mutate()}>Verify & link</Button>
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ Tally

function TallyCard() {
  const { user } = useAuth()
  const yday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const [from, setFrom] = useState(yday)
  const [to, setTo] = useState(yday)
  const [reexport, setReexport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<string | null>(null)
  const allowed = ['billing', 'management', 'admin'].includes(user?.role ?? '')
  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/tally/export', { from, to, reexport: reexport || undefined }), { headers: auth() })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `tally-vouchers_${from}_${to}.xml`
      a.click()
      URL.revokeObjectURL(a.href)
      const summary = `${res.headers.get('X-Vouchers')} vouchers · ${res.headers.get('X-New-Postings')} new GL postings · batch ${res.headers.get('X-Export-Batch')}`
      setLast(summary)
      toast.success(summary)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Tally / ERP voucher export" icon="FileCode2" className="max-w-2xl">
      <p className="mb-3 text-xs text-ink-2">Sales vouchers per bill and Receipt / Payment / Journal vouchers per money movement, mapped to Tally ledgers
        (Cash, UPI / card settlement banks, Patient Receivables, IP Advances, revenue heads, Output GST). Import via Gateway → Import Data.</p>
      <div className="flex flex-wrap items-end gap-2">
        <FieldWrap label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="To"><Input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} className="w-40" /></FieldWrap>
        <label className="flex h-9 items-center gap-2 text-sm text-ink-2"><input type="checkbox" className="accent-brand-700" checked={reexport} onChange={(e) => setReexport(e.target.checked)} /> Include already exported</label>
        <Button variant="primary" loading={busy} disabled={!allowed} onClick={run}><Download className="size-4" /> Export XML</Button>
      </div>
      {last && <p className="mt-2 text-xs text-ink-2">Last export: {last}</p>}
      {!allowed && <p className="mt-2 text-xs text-ink-3">Only billing and management can export.</p>}
    </Card>
  )
}

// ------------------------------------------------------------------ page

export default function IntegrationHub(_: BespokeProps) {
  const [tab, setTab] = useState<Tab>('status')
  const messages = useEntity('connectors.messages')
  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'status', label: 'Connector status', icon: 'Activity' },
        { key: 'fhir', label: 'FHIR explorer', icon: 'Braces' },
        { key: 'hl7', label: 'HL7 console', icon: 'TerminalSquare' },
        { key: 'abha', label: 'ABHA', icon: 'BadgeCheck' },
        { key: 'tally', label: 'Tally export', icon: 'FileCode2' },
        { key: 'log', label: 'Message log', icon: 'ScrollText' },
      ]} />
      {tab === 'status' && <StatusCards />}
      {tab === 'fhir' && <FhirExplorer />}
      {tab === 'hl7' && <Hl7Console />}
      {tab === 'abha' && <AbhaVerify />}
      {tab === 'tally' && <TallyCard />}
      {tab === 'log' && (messages ? <EntityView entity={messages} /> : <Empty icon="ScrollText" title="Message log is not available" />)}
    </div>
  )
}
