/**
 * Clinical Forms workspace (EMR module page): pick a patient and admission, then use the form library,
 * the intake/output flowsheet or the OT booklet. Also lists the user's open drafts and today's high-risk scores.
 * Deep link: ?patient=<id>&encounter=<id>&tab=library|io|ot&form=<form key>
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { RefPicker } from '@/components/fields'
import { Badge, Card, cn, Empty, FieldWrap, Spinner, StatusBadge, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { useEntries, useFormDefs } from './api'
import { FormHistory } from './FormHistory'
import { FormLibrary } from './FormLibrary'
import { IoFlowsheet } from './IoFlowsheet'
import { badgeTone } from './logic'
import { OtBooklet } from './OtBooklet'
import type { EntryRow } from './types'

type Tab = 'library' | 'io' | 'ot' | 'history'

interface Header {
  name: string; uhid: string; gender?: string; age?: number | null
  admission: { id?: string; code?: string; type?: string; status?: string; location?: string; doctor_name?: string; diagnosis?: string } | null
}

export default function FormsWorkspace() {
  const [sp, setSp] = useSearchParams()
  const patient = sp.get('patient') ?? ''
  const encounterParam = sp.get('encounter') ?? ''
  const tab = (sp.get('tab') as Tab) || 'library'
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k) }
    setSp(n, { replace: true })
  }
  const header = useQuery({
    queryKey: ['forms-ws-header', patient, encounterParam],
    queryFn: () => api<Header>('/forms/patient-header', { query: { patient_id: patient, encounter_id: encounterParam || undefined } }),
    enabled: !!patient,
  })
  const encounter = encounterParam || header.data?.admission?.id || undefined
  const defs = useFormDefs()
  const suites = useMemo(() => new Set((defs.data?.forms ?? []).flatMap((f) => [f.suite, ...f.also_in])), [defs.data])
  const canIo = (defs.data?.forms ?? []).some((f) => f.component === 'io_flowsheet')
  const canOt = suites.has('ot')
  const tabs = [
    { key: 'library' as Tab, label: 'Form library', icon: 'ClipboardList' },
    ...(canIo ? [{ key: 'io' as Tab, label: 'Intake / output', icon: 'Droplets' }] : []),
    ...(canOt ? [{ key: 'ot' as Tab, label: 'OT booklet', icon: 'BookOpen' }] : []),
    { key: 'history' as Tab, label: 'Entries', icon: 'History' },
  ]

  return (
    <div className="space-y-4">
      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <FieldWrap label="Patient" className="w-80">
            <RefPicker refName="registration.patients" kind="patient" value={patient || null} placeholder="Search by name, UHID or mobile…"
              onChange={(id) => set({ patient: id, encounter: null, form: null })} />
          </FieldWrap>
          {patient && (
            <FieldWrap label="Admission / visit" className="w-72">
              <RefPicker refName="ipd.encounters" value={encounter ?? null} extraFilter={{ patient_id: patient }} placeholder="Current encounter"
                onChange={(id) => set({ encounter: id })} />
            </FieldWrap>
          )}
          {header.data && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pb-1 text-sm">
              <Link to={`/patients/${patient}`} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">{header.data.name}</Link>
              <span className="font-mono text-xs text-ink-3">{header.data.uhid}</span>
              <span className="text-xs text-ink-2">{header.data.age ?? '—'} y · {header.data.gender ?? '—'}</span>
              {header.data.admission ? (
                <>
                  <Badge tone="blue">{header.data.admission.code} · {header.data.admission.status}</Badge>
                  {header.data.admission.location && <span className="text-xs text-ink-2">{header.data.admission.location}</span>}
                  {header.data.admission.diagnosis && <span className="truncate text-xs text-ink-3">· {header.data.admission.diagnosis}</span>}
                </>
              ) : <Badge tone="gray">No active admission</Badge>}
            </div>
          )}
        </div>
      </Card>

      {!patient ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="My drafts" icon="FilePen" pad={false}><Worklist kind="drafts" onOpen={(r) => set({ patient: r.patient_id, encounter: r.encounter_id ?? null, form: r.form_key, tab: 'library' })} /></Card>
          <Card title="High-risk scores · last 48 h" icon="Siren" pad={false}><Worklist kind="risk" onOpen={(r) => set({ patient: r.patient_id, encounter: r.encounter_id ?? null, tab: 'history' })} /></Card>
        </div>
      ) : header.isLoading ? <Spinner /> : (
        <>
          <Tabs tabs={tabs} value={tabs.some((t) => t.key === tab) ? tab : 'library'} onChange={(k) => set({ tab: k })} />
          {tab === 'library' && <FormLibrary key={`${patient}:${encounter ?? ''}`} patientId={patient} encounterId={encounter} initialForm={sp.get('form') ?? undefined}
            onSelect={(k) => set({ form: k })} />}
          {tab === 'io' && canIo && <IoFlowsheet patientId={patient} encounterId={encounter} />}
          {tab === 'ot' && canOt && <OtBooklet patientId={patient} encounterId={encounter} />}
          {tab === 'history' && <Card title="Clinical form entries" icon="History"><FormHistory patientId={patient} encounterId={encounter} limit={50} /></Card>}
        </>
      )}
    </div>
  )
}

function Worklist({ kind, onOpen }: { kind: 'drafts' | 'risk'; onOpen: (r: EntryRow) => void }) {
  const q = useEntries(kind === 'drafts' ? { mine: true, status: 'Draft', days: 30, limit: 100 } : { days: 2, status: 'Signed,Amended', limit: 300 })
  const rows = (q.data?.rows ?? []).filter((r) => kind === 'drafts' || r.risk_tone === 'red').slice(0, 25)
  if (q.isLoading) return <Spinner />
  if (!rows.length) {
    return <Empty icon={kind === 'drafts' ? 'FileCheck' : 'ShieldCheck'} title={kind === 'drafts' ? 'No open drafts' : 'No high-risk scores'}>
      {kind === 'drafts' ? 'Forms you start and do not sign appear here.' : 'Signed scores in a red band from the last 48 hours appear here.'}
    </Empty>
  }
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left hover:bg-surface-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.patient_name ?? '—'} <span className="font-normal text-ink-2">· {r.form_title}</span></span>
            {r.score !== null && r.score !== undefined && <Badge tone={badgeTone(r.risk_tone)}>{r.score_label} {r.score}{r.risk_band ? ` · ${r.risk_band}` : ''}</Badge>}
            <StatusBadge status={r.status} />
            <span className={cn('w-full text-xs text-ink-3')}>{r.uhid} · {dateTime(r.noted_at)} · {r.author_name ?? '—'} · {r.summary ?? ''}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

