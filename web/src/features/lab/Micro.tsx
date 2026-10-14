import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Segmented, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { PriorityBadge } from '@/pages/bespoke/lab-worklist'
import { MicroTable } from './reportview'
import { Kpi, LabShell, useLabAccess } from './shell'
import type { LabRow, MicroOrganism, MicroReport } from './types'

interface Meta { organisms: { name: string; panel: string }[]; panels: Record<string, string[]>; panel_source: string; specimens: string[]
  culture_results: string[]; colony_counts: string[] }
type Row = LabRow & { hours_incubated?: number | null }
const RESISTANCE = ['ESBL', 'MRSA', 'VRE', 'CRE', 'MDR', 'XDR', 'Carbapenemase']
const SIR: { key: 'S' | 'I' | 'R'; cls: string }[] = [
  { key: 'S', cls: 'bg-emerald-600 text-white' }, { key: 'I', cls: 'bg-amber-500 text-white' }, { key: 'R', cls: 'bg-red-600 text-white' },
]

const blank = (): MicroReport => ({ specimen: '', gram_stain: '', culture_result: 'No growth', incubation_hours: 48, organisms: [], comments: '' })

export default function Microbiology() {
  const acc = useLabAccess()
  const [stage, setStage] = useState<'pending' | 'resulted' | 'all'>('pending')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const meta = useQuery({ queryKey: ['x', 'lab', 'micro-meta'], queryFn: () => api<Meta>('/lab/micro/meta'), staleTime: 300_000 })
  const list = useQuery({
    queryKey: ['x', 'lab', 'micro', stage, q],
    queryFn: () => api<{ rows: Row[]; counts: { pending: number; preliminary: number; resulted: number } }>('/lab/micro', { query: { stage, q: q || undefined } }),
    placeholderData: (p) => p,
  })
  const rows = list.data?.rows ?? []
  const open = rows.find((r) => r.id === openId) ?? null
  const c = list.data?.counts
  return (
    <LabShell screen="micro" icon="Microscope" title="Microbiology"
      subtitle="Culture & sensitivity: specimen, Gram stain, growth, organism with colony count and resistance markers, and the antibiotic S / I / R panel. Issue a preliminary report, then the final report for authorisation."
      actions={c && <div className="flex gap-2"><Kpi icon="Microscope" label="At the bench" value={c.pending} /><Kpi icon="FileClock" label="Preliminary issued" value={c.preliminary} /><Kpi icon="ShieldCheck" label="To authorise" value={c.resulted} /></div>}>
      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card pad={false} title="Cultures" actions={<Segmented value={stage} onChange={setStage} options={[{ key: 'pending', label: 'Bench' }, { key: 'resulted', label: 'To authorise' }, { key: 'all', label: 'All' }]} />}>
          <div className="border-b border-line p-2">
            <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Barcode / patient / UHID" aria-label="Search cultures" /></div>
          </div>
          {list.isLoading && <Spinner />}
          {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
          {list.data && rows.length === 0 && <Empty icon="Microscope" title="No cultures here" />}
          <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto scroll-thin">
            {rows.map((r) => (
              <li key={r.id}>
                <button onClick={() => setOpenId(r.id)} className={cn('w-full px-3 py-2 text-left hover:bg-surface-2', openId === r.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-ink">{r.patient.name}</span><StatusBadge status={r.status} /></div>
                  <div className="text-xs text-ink-2">{r.test.name} · <span className="font-mono">{r.sample_barcode ?? r.code}</span></div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                    <PriorityBadge priority={r.priority} />{r.hours_incubated != null && <span>{r.hours_incubated} h since collection</span>}
                    {r.micro?.preliminary_at && <Badge tone="violet">Preliminary</Badge>}{r.micro?.culture_result === 'Growth' && <Badge tone="red">Growth</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {!open ? <Card><Empty icon="Microscope" title="Choose a culture on the left" /></Card>
          : <MicroEditor key={open.id} r={open} meta={meta.data} edit={acc.benchEdit && ['Collected', 'In Progress', 'Resulted'].includes(open.status)} />}
      </div>
    </LabShell>
  )
}

function MicroEditor({ r, meta, edit }: { r: Row; meta?: Meta; edit: boolean }) {
  const qc = useQueryClient()
  const [m, setM] = useState<MicroReport>(() => ({ ...blank(), ...(r.micro ?? {}), specimen: r.micro?.specimen ?? r.test.sample_type ?? '' }))
  const [panels, setPanels] = useState<string[]>(() => (r.micro?.organisms ?? []).map(() => ''))
  const save = useMutation({
    mutationFn: (final: boolean) => api<{ status: string }>(`/lab/micro/${r.id}`, {
      method: 'POST',
      body: { ...m, incubation_hours: m.incubation_hours || undefined, specimen: m.specimen || undefined, gram_stain: m.gram_stain || undefined,
        comments: m.comments || undefined, organisms: m.culture_result === 'Growth' ? m.organisms : [], final },
    }),
    onSuccess: (res, final) => { toast.success(final ? `Final report saved — ${res.status}, awaiting authorisation` : 'Preliminary report saved'); qc.invalidateQueries({ queryKey: ['x', 'lab'] }); qc.invalidateQueries({ queryKey: ['x', 'orders'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const setOrg = (i: number, f: (o: MicroOrganism) => MicroOrganism) => setM((cur) => ({ ...cur, organisms: cur.organisms.map((o, j) => (j === i ? f(o) : o)) }))
  const panelFor = (i: number, o: MicroOrganism) => panels[i] || meta?.organisms.find((x) => x.name === o.organism)?.panel || 'Gram-negative'
  const applyPanel = (i: number, panel: string) => {
    setPanels((cur) => { const n = [...cur]; n[i] = panel; return n })
    const abx = meta?.panels[panel] ?? []
    setOrg(i, (x) => ({ ...x, sensitivity: abx.map((a) => x.sensitivity.find((s) => s.antibiotic === a) ?? { antibiotic: a, interpretation: 'S' as const, mic: '' }) }))
  }
  if (!edit) {
    return (
      <Card title={<>{r.test.name} · {r.patient.name}</>}>
        {r.micro ? <MicroTable m={r.micro} /> : <p className="text-sm text-ink-3">No culture report entered yet.</p>}
      </Card>
    )
  }
  const valid = m.culture_result !== 'Growth' || (m.organisms.length > 0 && m.organisms.every((o) => o.organism.trim().length > 1))
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">{r.test.name} · {r.patient.name} <span className="font-mono text-xs text-ink-3">{r.sample_barcode ?? r.code}</span><StatusBadge status={r.status} /></span>}
      actions={r.micro?.preliminary_at && <span className="text-xs text-ink-3">Preliminary {dateTime(r.micro.preliminary_at)} · {r.micro.preliminary_by}</span>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <FieldWrap label="Specimen">
            <Input list="w7-specimens" value={m.specimen ?? ''} onChange={(e) => setM({ ...m, specimen: e.target.value })} />
            <datalist id="w7-specimens">{meta?.specimens.map((s) => <option key={s} value={s} />)}</datalist>
          </FieldWrap>
          <FieldWrap label="Incubation (hours)"><Input type="number" min={0} max={720} value={m.incubation_hours ?? ''} onChange={(e) => setM({ ...m, incubation_hours: e.target.value ? Number(e.target.value) : null })} /></FieldWrap>
          <FieldWrap label="Gram stain"><Input value={m.gram_stain ?? ''} onChange={(e) => setM({ ...m, gram_stain: e.target.value })} placeholder="e.g. Gram-negative bacilli seen" /></FieldWrap>
        </div>
        <FieldWrap label="Culture">
          <Segmented value={m.culture_result} onChange={(v) => setM({ ...m, culture_result: v, organisms: v === 'Growth' && !m.organisms.length ? [{ organism: '', colony_count: '', resistance: [], sensitivity: [] }] : m.organisms })}
            options={(meta?.culture_results ?? ['No growth', 'Growth', 'Normal flora', 'Contaminated — repeat sample']).map((x) => ({ key: x, label: x }))} />
        </FieldWrap>
        {m.culture_result === 'Growth' && m.organisms.map((o, i) => (
          <div key={i} className="rounded-xl border border-line p-3">
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <FieldWrap label={`Organism ${i + 1}`} className="min-w-64 flex-1">
                <Input list="w7-organisms" value={o.organism} onChange={(e) => { const v = e.target.value; setOrg(i, (x) => ({ ...x, organism: v })) }} placeholder="Type or pick an organism" />
                <datalist id="w7-organisms">{meta?.organisms.map((x) => <option key={x.name} value={x.name} />)}</datalist>
              </FieldWrap>
              <FieldWrap label="Colony count">
                <Select value={o.colony_count ?? ''} onChange={(e) => { const v = e.target.value; setOrg(i, (x) => ({ ...x, colony_count: v })) }} className="w-44">
                  <option value="">—</option>{meta?.colony_counts.map((x) => <option key={x}>{x}</option>)}
                </Select>
              </FieldWrap>
              <FieldWrap label="Antibiotic panel">
                <Select value={panelFor(i, o)} onChange={(e) => applyPanel(i, e.target.value)} className="w-40">
                  {Object.keys(meta?.panels ?? {}).map((p) => <option key={p}>{p}</option>)}
                </Select>
              </FieldWrap>
              {!o.sensitivity.length && <Button size="sm" onClick={() => applyPanel(i, panelFor(i, o))}>Load panel</Button>}
              <Button size="sm" variant="ghost" aria-label="Remove organism" onClick={() => setM({ ...m, organisms: m.organisms.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
            </div>
            <div className="mb-3 flex flex-wrap gap-3">
              {RESISTANCE.map((x) => (
                <label key={x} className="flex items-center gap-1.5 text-xs text-ink-2">
                  <input type="checkbox" className="size-4 accent-brand-700" checked={o.resistance.includes(x)}
                    onChange={(e) => setOrg(i, (y) => ({ ...y, resistance: e.target.checked ? [...y.resistance, x] : y.resistance.filter((z) => z !== x) }))} />{x}
                </label>
              ))}
            </div>
            {o.sensitivity.length > 0 && (
              <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {o.sensitivity.map((s, k) => (
                  <div key={s.antibiotic} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink" title={s.antibiotic}>{s.antibiotic}</span>
                    <div className="flex overflow-hidden rounded-md border border-line-2" role="radiogroup" aria-label={`${s.antibiotic} interpretation`}>
                      {SIR.map((x) => (
                        <button key={x.key} type="button" role="radio" aria-checked={s.interpretation === x.key}
                          className={cn('w-7 py-0.5 text-xs font-bold', s.interpretation === x.key ? x.cls : 'text-ink-3 hover:bg-surface-2')}
                          onClick={() => setOrg(i, (y) => ({ ...y, sensitivity: y.sensitivity.map((z, n) => (n === k ? { ...z, interpretation: x.key } : z)) }))}>{x.key}</button>
                      ))}
                    </div>
                    <Input className="h-7 w-16 text-xs" placeholder="MIC" value={s.mic ?? ''} aria-label={`${s.antibiotic} MIC`}
                      onChange={(e) => { const v = e.target.value; setOrg(i, (y) => ({ ...y, sensitivity: y.sensitivity.map((z, n) => (n === k ? { ...z, mic: v } : z)) })) }} />
                    <button type="button" aria-label={`Remove ${s.antibiotic}`} className="text-ink-3 hover:text-red-600"
                      onClick={() => setOrg(i, (y) => ({ ...y, sensitivity: y.sensitivity.filter((_, n) => n !== k) }))}><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {m.culture_result === 'Growth' && m.organisms.length < 4 && (
          <Button size="sm" variant="ghost" onClick={() => setM({ ...m, organisms: [...m.organisms, { organism: '', colony_count: '', resistance: [], sensitivity: [] }] })}><Plus className="size-4" />Add organism</Button>
        )}
        <FieldWrap label="Comments"><Textarea rows={2} value={m.comments ?? ''} onChange={(e) => setM({ ...m, comments: e.target.value })} placeholder="e.g. ESBL producer — contact precautions advised" /></FieldWrap>
        {meta?.panel_source === 'built-in' && <p className="text-xs text-ink-3">Using the built-in antibiotic panels — define the hospital's panels in Lab setup → Antibiotic Panels.</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          <Button loading={save.isPending && save.variables === false} disabled={!valid} onClick={() => save.mutate(false)}>Save preliminary report</Button>
          <Button variant="primary" icon="Send" loading={save.isPending && save.variables === true} disabled={!valid} onClick={() => save.mutate(true)}>Final report → authorisation</Button>
        </div>
      </div>
    </Card>
  )
}
