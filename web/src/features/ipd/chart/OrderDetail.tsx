import { useQuery } from '@tanstack/react-query'
import { Badge, Button, cn, ErrorBox, Modal, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, minutes } from '@/lib/format'
import { Icon } from '@/lib/icons'

interface Detail {
  id: string; code: string; status: string; category: string; priority: string; critical: boolean
  patient: { name: string; uhid: string; age?: number | null; gender?: string | null }
  test: { name: string; section?: string | null; modality?: string | null; sample_type?: string | null }
  ordered_at?: string | null; collected_at?: string | null; resulted_at?: string | null; verified_at?: string | null; scheduled_at?: string | null
  result_values: { parameter: string; value?: string | null; unit?: string | null; ref_range?: string | null; flag?: string | null }[]
  result?: string | null; impression?: string | null; verified_by?: string | null; resulted_by?: string | null; ordering_doctor?: string | null
  sample_barcode?: string | null; accession_no?: string | null; tat_minutes?: number | null; location?: string | null; acknowledged_at?: string | null
}

const STEPS: [keyof Detail, string][] = [['ordered_at', 'Ordered'], ['scheduled_at', 'Scheduled'], ['collected_at', 'Sample collected'], ['resulted_at', 'Resulted'], ['verified_at', 'Verified & reported']]

/** Track an order through its stages and view / print its report. */
export function OrderDetailModal({ id, mode, onClose, hospital = 'Vlack Multispecialty Hospital' }: { id: string; mode: 'track' | 'report'; onClose: () => void; hospital?: string }) {
  const q = useQuery({ queryKey: ['x', 'orders', 'detail', id], queryFn: () => api<Detail>(`/orders/${id}/detail`) })
  const d = q.data
  const reported = d && (d.status === 'Resulted' || d.status === 'Verified')
  const print = () => {
    if (!d) return
    const w = window.open('', '_blank')
    if (!w) return
    const rows = d.result_values.map((v) => `<tr><td>${v.parameter}</td><td><b>${v.value ?? ''}</b> ${v.unit ?? ''}</td><td>${v.ref_range ?? ''}</td><td>${v.flag && v.flag !== 'Normal' ? `<b>${v.flag}</b>` : v.flag ?? ''}</td></tr>`).join('')
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${d.code} report</title><style>body{font:12px/1.5 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:16px;margin:0}h2{font-size:13px;margin:16px 0 4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}.box{border:1px solid #ccc;padding:8px;margin-top:8px}.muted{color:#555}</style></head><body>
      <h1>${hospital}</h1><div class="muted">${d.category === 'RAD' ? 'Diagnostic imaging report' : 'Laboratory report'}</div>
      <div class="box"><b>${d.patient.name}</b> · UHID ${d.patient.uhid} · ${d.patient.age ?? ''}${d.patient.gender ? ' / ' + d.patient.gender : ''}<br/>Test: <b>${d.test.name}</b> · Order ${d.code}${d.accession_no ? ' · Accession ' + d.accession_no : ''}<br/>Ordered ${d.ordered_at ? dateTime(d.ordered_at) : ''} · Reported ${d.verified_at ? dateTime(d.verified_at) : d.resulted_at ? dateTime(d.resulted_at) : ''}</div>
      ${rows ? `<h2>Results</h2><table><tr><th>Parameter</th><th>Result</th><th>Reference</th><th>Flag</th></tr>${rows}</table>` : ''}
      ${d.result ? `<h2>Report</h2><div style="white-space:pre-wrap">${d.result.replace(/</g, '&lt;')}</div>` : ''}
      ${d.impression ? `<h2>Impression</h2><div>${d.impression.replace(/</g, '&lt;')}</div>` : ''}
      <p class="muted" style="margin-top:24px">${d.verified_by ? 'Verified by ' + d.verified_by : 'Not yet verified'} · This is a computer-generated document.</p>
      <script>window.onload=()=>window.print()</script></body></html>`)
    w.document.close()
  }
  return (
    <Modal open onClose={onClose} size="lg" title={d ? `${mode === 'track' ? 'Track' : 'Report'} · ${d.test.name} · ${d.code}` : 'Order'}
      footer={<>{reported && <Button icon="Printer" variant="primary" onClick={print}>Print report</Button>}<Button variant="ghost" onClick={onClose}>Close</Button></>}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : d && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={reported ? 'green' : d.status === 'Cancelled' ? 'gray' : 'blue'} dot>{d.status}</Badge>
            {d.priority !== 'Routine' && <Badge tone="red">{d.priority}</Badge>}
            {d.critical && <Badge tone="red">Critical result{d.acknowledged_at ? ' · acknowledged' : ''}</Badge>}
            {d.test.section && <Badge tone="gray">{d.test.section}</Badge>}
            {d.sample_barcode && <span className="font-mono text-xs text-ink-3">Sample {d.sample_barcode}</span>}
            {d.tat_minutes != null && <span className="text-xs text-ink-3">TAT {minutes(d.tat_minutes)}</span>}
          </div>
          <ol className="grid gap-2 sm:grid-cols-5">
            {STEPS.filter(([k]) => k !== 'scheduled_at' || d.scheduled_at).map(([k, label]) => {
              const at = d[k] as string | null | undefined
              return (
                <li key={k} className={cn('rounded-lg border px-3 py-2 text-xs', at ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'border-line')}>
                  <div className="flex items-center gap-1 font-medium text-ink"><Icon name={at ? 'CircleCheck' : 'Circle'} className={cn('size-3.5', at ? 'text-emerald-600' : 'text-ink-3')} />{label}</div>
                  <div className="text-ink-3">{at ? dateTime(at) : 'Pending'}</div>
                </li>
              )
            })}
          </ol>
          {mode === 'report' || reported ? (
            d.result_values.length || d.result || d.impression ? (
              <div className="space-y-3">
                {d.result_values.length > 0 && (
                  <table className="w-full text-sm">
                    <thead className="bg-surface-2 text-xs text-ink-3"><tr>{['Parameter', 'Result', 'Reference', 'Flag'].map((h) => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}</tr></thead>
                    <tbody>{d.result_values.map((v) => (
                      <tr key={v.parameter} className="border-t border-line">
                        <td className="px-2 py-1">{v.parameter}</td>
                        <td className={cn('px-2 py-1 font-medium tabular-nums', v.flag && v.flag !== 'Normal' && 'text-red-700 dark:text-red-300')}>{v.value} <span className="text-xs text-ink-3">{v.unit}</span></td>
                        <td className="px-2 py-1 text-ink-2">{v.ref_range ?? '—'}</td>
                        <td className="px-2 py-1">{v.flag ? <Badge tone={v.flag === 'Normal' ? 'green' : v.flag.startsWith('Critical') ? 'red' : 'amber'}>{v.flag}</Badge> : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
                {d.result && <div><h4 className="text-xs font-semibold uppercase text-ink-3">Report</h4><p className="whitespace-pre-wrap text-sm text-ink">{d.result}</p></div>}
                {d.impression && <div><h4 className="text-xs font-semibold uppercase text-ink-3">Impression</h4><p className="text-sm text-ink">{d.impression}</p></div>}
                <p className="text-xs text-ink-3">{d.verified_by ? `Verified by ${d.verified_by}` : 'Awaiting verification'}{d.resulted_by ? ` · resulted by ${d.resulted_by}` : ''}</p>
              </div>
            ) : <p className="text-sm text-ink-3">No result entered yet.</p>
          ) : <p className="text-sm text-ink-3">The report appears here once the department has resulted the test.</p>}
        </div>
      )}
    </Modal>
  )
}
