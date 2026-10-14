import { ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, cn, Empty, ErrorBox, Input, MenuItem, Popover, Spinner, Switch } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import { chartLink, useVisit, type VisitDetail, type VisitPerms } from './api'
import { BillingPanel } from './chart/Billing'
import { DispositionPanel } from './chart/Disposition'
import { DoctorAssessment, DoctorAssignment, TreatmentPanel } from './chart/Doctor'
import { ChartHeader } from './chart/Header'
import { HandoverPanel, NursingAssessment, TriagePanel, VitalsPanel } from './chart/Nursing'
import { MedicinesPanel, OrderEntry, ResultsPanel } from './chart/Orders'
import { Overview } from './chart/Overview'
import { DocumentsPanel, RegistrationPanel } from './chart/Registration'
import { LinkUhidDialog, MlcDialog, MoveBedDialog, PatientDetailsDialog } from './dialogs'

interface PanelDef { key: string; label: string; show: (p: VisitPerms) => boolean }
interface TabDef { key: string; label: string; icon: string; panels: PanelDef[] }

const clinical = (p: VisitPerms) => p.view_clinical
const TABS: TabDef[] = [
  { key: 'overview', label: 'Overview', icon: 'Activity', panels: [{ key: 'overview', label: 'Overview', show: () => true }] },
  { key: 'registration', label: 'ER Registration', icon: 'IdCard', panels: [{ key: 'registration', label: 'ER Registration', show: () => true }] },
  { key: 'nursing', label: 'Nursing', icon: 'HeartPulse', panels: [
    { key: 'triage', label: 'Triage', show: clinical }, { key: 'nursing-assessment', label: 'Nursing assessment', show: clinical },
    { key: 'vitals', label: 'Vitals & observations', show: clinical }, { key: 'handover', label: 'S-BAR handover', show: clinical },
  ] },
  { key: 'doctor', label: 'Doctor', icon: 'Stethoscope', panels: [
    { key: 'doctor-assignment', label: 'Doctor assignment', show: clinical }, { key: 'doctor-assessment', label: 'Doctor assessment', show: clinical },
    { key: 'treatment', label: 'Treatment & reassessment', show: clinical },
  ] },
  { key: 'orders', label: 'Order Desk', icon: 'ShoppingCart', panels: [
    { key: 'investigations', label: 'Investigations', show: clinical }, { key: 'medicines', label: 'Order medicine', show: clinical },
    { key: 'procedures', label: 'Procedures & services', show: clinical },
  ] },
  { key: 'results', label: 'Results', icon: 'FlaskConical', panels: [
    { key: 'lab', label: 'Lab reports', show: clinical }, { key: 'radiology', label: 'Radiology & PACS', show: clinical },
  ] },
  { key: 'disposition', label: 'Disposition', icon: 'LogOut', panels: [{ key: 'disposition', label: 'Disposition', show: (p) => p.view_clinical || p.dispose || p.abscond }] },
  { key: 'billing', label: 'Billing & Closure', icon: 'IndianRupee', panels: [{ key: 'billing', label: 'Billing & Closure', show: (p) => p.view_billing }] },
  { key: 'documents', label: 'Documents', icon: 'FileText', panels: [{ key: 'documents', label: 'Documents', show: (p) => p.documents || p.view_clinical }] },
]
const STEP_KEYS = new Set(['triage', 'nursing-assessment', 'doctor-assignment', 'doctor-assessment', 'treatment', 'disposition', 'billing'])

export default function VisitChart() {
  const { id = '' } = useParams()
  const q = useVisit(id)
  if (q.isLoading) return <Spinner label="Loading ER chart…" />
  if (q.error) {
    const denied = q.error instanceof ApiError && q.error.status === 403
    return <Empty icon={denied ? 'Lock' : 'TriangleAlert'} title={denied ? 'This ER chart is not available to your role' : 'Could not open the ER visit'}><ErrorBox error={q.error} /></Empty>
  }
  return <Chart d={q.data!} />
}

function Chart({ d }: { d: VisitDetail }) {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const p = d.permissions
  const s = d.summary
  const tabs = useMemo(() => TABS.map((t) => ({ ...t, panels: t.panels.filter((x) => x.show(p)) })).filter((t) => t.panels.length), [p])
  const panels = tabs.flatMap((t) => t.panels)
  const requested = params.get('step') ?? params.get('panel') ?? 'overview'
  const panel = panels.some((x) => x.key === requested) ? requested : 'overview'
  const tab = tabs.find((t) => t.panels.some((x) => x.key === panel)) ?? tabs[0]
  const go = (key: string) => {
    const next = new URLSearchParams()
    if (key !== 'overview') next.set(STEP_KEYS.has(key) ? 'step' : 'panel', key)
    setParams(next)
  }
  const [dlg, setDlg] = useState<'details' | 'link' | 'move' | 'mlc' | null>(null)
  useEffect(() => { if (params.get('edit') === 'details' && p.details && panel !== 'registration') go('registration') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useShortcuts('ER chart', [
    { keys: 'g', label: 'Go to the current workflow step', run: () => d.steps.current && go(STEP_MAP[d.steps.current] ?? 'overview') },
    ...(p.board ? [{ keys: 'b', label: 'Back to the ward board', run: () => nav('/er/board') }] : []),
  ])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => nav(-1)} aria-label="Back" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"><Icon name="ArrowLeft" className="size-5" /></button>
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-ink-2">
          {p.board ? <Link to="/er/board" className="hover:text-ink">Emergency</Link> : <span>Emergency</span>}
          <span className="text-ink-3">›</span>
          {p.tracking ? <Link to="/er/tracking" className="hover:text-ink">Tracking board</Link> : <span>ER visit</span>}
          <span className="text-ink-3">›</span>
          <span className="font-semibold text-ink">{s.code}</span>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PageSearch panels={panels} onGo={go} />
          <PrintMenu d={d} />
          {p.details && <Button size="sm" icon="UserPen" onClick={() => setDlg('details')}>{d.temporary ? 'Add patient details' : 'Patient details'}</Button>}
          {p.link && <Button size="sm" icon="Link" onClick={() => setDlg('link')}>Link UHID</Button>}
          {p.move_bed && <Button size="sm" icon="BedDouble" onClick={() => setDlg('move')}>{s.bed ? 'Move bed' : 'Assign bed'}</Button>}
          {p.mlc && (
            <label className="inline-flex h-8 items-center gap-2 rounded-lg border border-line-2 bg-surface px-2.5 text-sm text-ink shadow-sm">
              <Icon name="ShieldAlert" className="size-4 text-violet-600" /> MLC
              <Switch size="sm" checked={s.mlc} onChange={() => setDlg('mlc')} label="Medico-legal case" />
            </label>
          )}
          {p.tracking && <Link to="/er/tracking"><Button size="sm" icon="ClipboardList">Tracking board</Button></Link>}
          <Popover trigger={({ toggle }) => <Button size="sm" variant="ghost" onClick={toggle} aria-label="More actions"><Icon name="EllipsisVertical" className="size-4" /></Button>}>
            {(close) => (
              <>
                {!d.temporary && <MenuItem icon="UserRound" onClick={() => { close(); nav(`/patients/${s.patient.id}`) }}>Patient 360°</MenuItem>}
                <MenuItem icon="Copy" onClick={() => { close(); navigator.clipboard?.writeText(s.code) }}>Copy ER number</MenuItem>
                {p.board && <MenuItem icon="Siren" onClick={() => { close(); nav('/er/board') }}>Ward board</MenuItem>}
              </>
            )}
          </Popover>
        </div>
      </div>

      <ChartHeader d={d} />

      <TabBar tabs={tabs} active={tab.key} panel={panel} onGo={go} />

      <div>
        {panel === 'overview' && <Overview d={d} />}
        {panel === 'registration' && <RegistrationPanel d={d} editDetails={params.get('edit') === 'details'} onEditDone={() => go('registration')} />}
        {panel === 'triage' && <TriagePanel d={d} />}
        {panel === 'nursing-assessment' && <NursingAssessment d={d} />}
        {panel === 'vitals' && <VitalsPanel d={d} />}
        {panel === 'handover' && <HandoverPanel d={d} />}
        {panel === 'doctor-assignment' && <DoctorAssignment d={d} />}
        {panel === 'doctor-assessment' && <DoctorAssessment d={d} />}
        {panel === 'treatment' && <TreatmentPanel d={d} />}
        {panel === 'investigations' && <OrderEntry d={d} kind="investigations" />}
        {panel === 'procedures' && <OrderEntry d={d} kind="procedures" />}
        {panel === 'medicines' && <MedicinesPanel d={d} />}
        {panel === 'lab' && <ResultsPanel d={d} kind="lab" />}
        {panel === 'radiology' && <ResultsPanel d={d} kind="radiology" />}
        {panel === 'disposition' && <DispositionPanel d={d} />}
        {panel === 'billing' && <BillingPanel visitId={s.id} />}
        {panel === 'documents' && <DocumentsPanel d={d} />}
      </div>

      {dlg === 'details' && <PatientDetailsDialog visitId={s.id} open onClose={() => setDlg(null)} temporary={d.temporary} visit={d.visit} patient={d.patient} canLink={p.link} />}
      {dlg === 'link' && <LinkUhidDialog visitId={s.id} code={s.code} current={`${d.patient.title} (${d.patient.code})`} open onClose={() => setDlg(null)} />}
      {dlg === 'move' && <MoveBedDialog visit={s} open onClose={() => setDlg(null)} />}
      {dlg === 'mlc' && <MlcDialog visit={s} open onClose={() => setDlg(null)} marked={s.mlc} mlcNo={s.mlc_no} />}
    </div>
  )
}

const STEP_MAP: Record<string, string> = {
  registration: 'registration', triage: 'triage', nursing_assessment: 'nursing-assessment', doctor_assignment: 'doctor-assignment',
  doctor_assessment: 'doctor-assessment', orders: 'investigations', treatment: 'treatment', disposition: 'disposition', billing: 'billing',
}

function TabBar({ tabs, active, panel, onGo }: { tabs: TabDef[]; active: string; panel: string; onGo: (k: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface px-2 scroll-thin" role="tablist">
      {tabs.map((t) => {
        const on = t.key === active
        const cls = cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium',
          on ? 'border-brand-700 text-brand-800 dark:border-brand-400 dark:text-brand-300' : 'border-transparent text-ink-2 hover:text-ink')
        if (t.panels.length === 1) {
          return <button key={t.key} type="button" role="tab" aria-selected={on} className={cls} onClick={() => onGo(t.panels[0].key)}><Icon name={t.icon} className="size-4" />{t.label}</button>
        }
        return (
          <Popover key={t.key} align="left" className="w-60" trigger={({ toggle, open }) => (
            <button type="button" role="tab" aria-selected={on} aria-haspopup="menu" aria-expanded={open} className={cls} onClick={toggle}>
              <Icon name={t.icon} className="size-4" />{t.label}<ChevronDown className="size-3.5" />
            </button>
          )}>
            {(close) => t.panels.map((x) => (
              <MenuItem key={x.key} icon={x.key === panel ? 'Check' : undefined} onClick={() => { close(); onGo(x.key) }}>{x.label}</MenuItem>
            ))}
          </Popover>
        )
      })}
    </div>
  )
}

function PageSearch({ panels, onGo }: { panels: PanelDef[]; onGo: (k: string) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const hits = panels.filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
  return (
    <div className="relative w-48">
      <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
      <Input ref={ref} value={q} className="h-8 pl-8 text-sm" placeholder="Search pages…" aria-label="Search pages in this chart"
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { onGo(hits[0].key); setQ(''); ref.current?.blur() } }} />
      {open && hits.length > 0 && (
        <div className="absolute right-0 z-30 mt-1 w-60 rounded-xl border border-line bg-surface py-1 shadow-xl">
          {hits.map((h) => <MenuItem key={h.key} onClick={() => { onGo(h.key); setQ('') }}>{h.label}</MenuItem>)}
        </div>
      )}
    </div>
  )
}

function PrintMenu({ d }: { d: VisitDetail }) {
  const p = d.permissions
  const docs = [
    { key: 'registration', label: 'Registration slip', show: true },
    { key: 'case-sheet', label: 'ER case sheet', show: p.view_clinical },
    { key: 'triage', label: 'Triage record', show: p.view_clinical },
    { key: 'nursing', label: 'Nursing assessment', show: p.view_clinical && !!d.nursing },
    { key: 'discharge-summary', label: 'ER discharge summary', show: p.view_clinical },
    { key: 'handover', label: 'S-BAR handover', show: p.view_clinical && d.handovers.length > 0 },
    { key: 'mlc', label: 'MLC intimation', show: p.print_mlc && d.summary.mlc },
  ].filter((x) => x.show)
  return (
    <Popover className="w-56" trigger={({ toggle }) => <Button size="sm" icon="Printer" onClick={toggle}>Print <ChevronDown className="size-3.5" /></Button>}>
      {(close) => docs.map((x) => (
        <a key={x.key} href={`${chartLink(d.summary.id).split('?')[0]}/print?doc=${x.key}`} target="_blank" rel="noreferrer" onClick={close}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-2"><Icon name="FileText" className="size-4 text-ink-3" />{x.label}</a>
      ))}
    </Popover>
  )
}
