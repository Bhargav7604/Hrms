import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, cn, Empty, ErrorBox, MenuItem, Popover, Spinner } from '@/components/ui'
import { FormLibrary } from '@/features/forms'
import { api, errorMessage } from '@/lib/api'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import { chartScope, useChart, useMessageCount, type ChartHeader, type TabKey } from '../api'
import { ChangePatientModal, ChangeSponsorModal, InitiateDischargeModal } from './Actions'
import { Banner } from './Banner'
import { DoctorTab, FormPage, FormsTab, HicTab, MonitoringTab, NursingTab, OtTab, SuiteTab } from './ClinicalTabs'
import { ConsentTab, DocumentsTab } from './DocsConsent'
import { CancellationsPage, ChargePage, EquipmentPage, InvestigationsPage, MedicationPage, PharmacyReturnPage, ServiceRequestPage } from './OrderDesk'
import { Overview, type ChartItHandle } from './Overview'
import { subsFor, TABS, type TabDef } from './tabs'
import { DischargeTrackerDrawer } from './Tracker'

/** The IP chart — the per-admission inpatient workspace (`/ip/admissions/:id?tab=…&sub=…`). */
export default function AdmissionChart() {
  const { id = '' } = useParams()
  const q = useChart(id)
  if (q.isLoading) return <Spinner label="Opening the IP chart…" />
  if (q.error) return <div className="space-y-3"><Link to="/ip/admissions" className="text-sm text-brand-700 hover:underline">← Admissions</Link><ErrorBox error={q.error} /></div>
  return <Chart h={q.data!} />
}

function Chart({ h }: { h: ChartHeader }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const a = h.admission
  const p = h.permissions
  const open = a.status === 'Admitted' || a.status === 'Discharge Initiated'
  const visible = TABS.filter((t) => p.tabs[t.key])
  const req = params.get('tab') as TabKey | null
  const tab = visible.find((t) => t.key === req) ?? visible[0]
  const sub = params.get('sub')
  const go = (t: string, s?: string) => {
    const n = new URLSearchParams()
    if (t !== 'overview') n.set('tab', t)
    if (s) n.set('sub', s)
    setParams(n)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const [tracker, setTracker] = useState(false)
  const [modal, setModal] = useState<'sponsor' | 'patient' | 'discharge' | null>(null)
  const chartIt = useRef<ChartItHandle>(null)
  const msgs = useMessageCount(h.patient.id, a.id)
  const accept = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${a.id}/accept`, { method: 'POST', body: {} }),
    onSuccess: () => { toast.success('Patient accepted on the ward'); chartScope(qc, a.id); qc.invalidateQueries({ queryKey: ['x', 'ipd'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  useShortcuts('IP chart', [
    { keys: 'o', label: 'Overview', run: () => go('overview') },
    ...(p.observe && open ? [{ keys: 'v', label: 'Record vitals', run: () => { go('overview'); setTimeout(() => chartIt.current?.open(), 100) } }] : []),
    ...(p.tabs.order_desk ? [{ keys: 'i', label: 'Investigations', run: () => go(p.tabs.investigations ? 'investigations' : 'order_desk') }] : []),
    ...(p.tabs.order_medication ? [{ keys: 'm', label: 'Order medication', run: () => go('order_medication') }] : []),
    { keys: 't', label: 'Discharge tracker', run: () => setTracker(true) },
  ])
  const messagesHref = `/messages?compose=1&patient=${h.patient.id}&encounter=${a.id}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1.5 text-sm text-ink-2" aria-label="Breadcrumb">
          <button type="button" onClick={() => nav(-1)} className="rounded-md p-1 hover:bg-surface-2" aria-label="Back"><Icon name="ArrowLeft" className="size-4" /></button>
          <Link to="/m/ipd" className="hover:text-ink">IPD</Link><span>›</span><Link to="/ip/admissions" className="hover:text-ink">Admissions</Link><span>›</span><span className="font-mono font-medium text-ink">{a.code}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to={messagesHref} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">
            <Icon name="MessageSquare" className="size-4" /> Messages{msgs.data ? <Badge tone="blue">{msgs.data}</Badge> : null}
          </Link>
          <Popover className="w-56" trigger={({ toggle }) => <Button size="sm" icon="Printer" onClick={toggle}>Print <Icon name="ChevronDown" className="size-3.5" /></Button>}>
            {(close) => (<>
              <MenuItem icon="QrCode" onClick={() => { close(); window.open(`/ip/admissions/${a.id}/print/wristband`, '_blank') }}>Wristband</MenuItem>
              <MenuItem icon="FileText" onClick={() => { close(); window.open(`/ip/admissions/${a.id}/print/face-sheet`, '_blank') }}>Face sheet</MenuItem>
              {p.tabs.doctor && <MenuItem icon="FileHeart" onClick={() => { close(); window.open(`/ip/admissions/${a.id}/print/case-summary`, '_blank') }}>Case summary</MenuItem>}
            </>)}
          </Popover>
          <Button size="sm" icon="Route" onClick={() => setTracker(true)}>Discharge tracker <span className="text-xs text-ink-3">{h.tracker.done}/{h.tracker.total}</span></Button>
          {p.sponsor && open && <Button size="sm" icon="Building2" onClick={() => setModal('sponsor')}>Change sponsor</Button>}
          {p.change_patient && open && <Button size="sm" icon="UserCog" onClick={() => setModal('patient')}>Change patient</Button>}
          {p.discharge && a.status === 'Admitted' && <Button size="sm" variant="primary" icon="LogOut" onClick={() => setModal('discharge')}>Initiate discharge</Button>}
          {a.status === 'Discharge Initiated' && <Badge tone="amber">Discharge initiated · {a.discharge_type ?? 'Routine'}</Badge>}
          {(p.accept && open && !a.accepted_at) && <Button size="sm" variant="success" icon="UserCheck" loading={accept.isPending} onClick={() => accept.mutate()}>Accept patient</Button>}
          <Popover className="w-56" trigger={({ toggle }) => <Button size="sm" variant="ghost" onClick={toggle} aria-label="More actions"><Icon name="EllipsisVertical" className="size-4" /></Button>}>
            {(close) => (<>
              <MenuItem icon="User" onClick={() => { close(); nav(`/patients/${h.patient.id}`) }}>Patient 360°</MenuItem>
              <MenuItem icon="LayoutGrid" onClick={() => { close(); nav('/m/ipd/bed-board') }}>Bed board</MenuItem>
              <MenuItem icon="Bed" onClick={() => { close(); nav('/ip/on-bed') }}>On bed census</MenuItem>
              {p.money && <MenuItem icon="Receipt" onClick={() => { close(); nav(`/ip/billing/discharge?admission=${a.id}`) }}>Discharge desk / bill</MenuItem>}
            </>)}
          </Popover>
        </div>
      </div>

      <Banner h={h} onRecordObs={() => { go('overview'); setTimeout(() => chartIt.current?.open(), 150) }} />

      <TabBar tabs={visible} active={tab.key} sub={sub} h={h} onPick={go} />

      {tab.key !== 'overview' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm"><Icon name={tab.icon} className="size-4 text-brand-700 dark:text-brand-300" /><b className="text-ink">{tab.label}</b>
            {sub && <span className="text-ink-2">› {subsFor(tab, p).find((s) => s.key === sub)?.label ?? sub}</span>}<span className="hidden truncate text-xs text-ink-3 md:inline">{tab.blurb}</span></div>
          <div className="flex gap-2"><Button size="sm" icon="Printer" onClick={() => window.print()}>Print page</Button><Button size="sm" icon="ArrowLeft" onClick={() => go('overview')}>Back to chart</Button></div>
        </div>
      )}

      <TabBody h={h} tab={tab} sub={sub} go={go} chartIt={chartIt} onAccept={() => accept.mutate()} accepting={accept.isPending} />

      <DischargeTrackerDrawer admissionId={a.id} open={tracker} onClose={() => setTracker(false)} money={p.money}
        onInitiate={p.discharge && a.status === 'Admitted' ? () => { setTracker(false); setModal('discharge') } : undefined} />
      {modal === 'sponsor' && <ChangeSponsorModal h={h} onClose={() => setModal(null)} />}
      {modal === 'patient' && <ChangePatientModal h={h} onClose={() => setModal(null)} />}
      {modal === 'discharge' && <InitiateDischargeModal h={h} onClose={() => setModal(null)} onDone={() => { setModal(null); setTracker(true) }} />}
    </div>
  )
}

function TabBar({ tabs, active, sub, h, onPick }: { tabs: TabDef[]; active: TabKey; sub: string | null; h: ChartHeader; onPick: (t: string, s?: string) => void }) {
  return (
    <div className="no-print flex flex-wrap gap-0.5 rounded-xl border border-line bg-surface px-2 py-1">
      {tabs.map((t) => {
        const subs = subsFor(t, h.permissions)
        const n = t.count ? h.counts[t.count] : undefined
        const cls = cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium', active === t.key ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')
        const label: ReactNode = <><Icon name={t.icon} className="size-4" />{t.label}{n ? <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-2 ring-1 ring-line">{n}</span> : null}</>
        if (!subs.length) return <button key={t.key} type="button" className={cls} onClick={() => onPick(t.key)} aria-current={active === t.key ? 'page' : undefined}>{label}</button>
        return (
          <Popover key={t.key} align="left" className="w-72" trigger={({ toggle, open }) => (
            <button type="button" className={cls} onClick={toggle} aria-expanded={open} aria-haspopup="menu">{label}<Icon name={open ? 'ChevronUp' : 'ChevronDown'} className="size-3.5" /></button>
          )}>
            {(close) => (
              <div>
                <div className="flex items-center gap-2 border-b border-line px-3 pb-2 pt-1">
                  <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-white"><Icon name={t.icon} className="size-4" /></span>
                  <div><div className="text-sm font-semibold text-ink">{t.label}</div><div className="text-[11px] text-ink-3">{subs.length} pages</div></div>
                </div>
                <div className="max-h-80 overflow-y-auto py-1 scroll-thin">
                  {subs.map((s) => (
                    <button key={s.key} type="button" onClick={() => { close(); onPick(t.key, s.key) }}
                      className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2', active === t.key && sub === s.key ? 'font-medium text-brand-800 dark:text-brand-300' : 'text-ink')}>
                      <span className="size-1.5 rounded-full bg-brand-600" />{s.label}{s.form && <Icon name="ClipboardList" className="ml-auto size-3.5 text-ink-3" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Popover>
        )
      })}
    </div>
  )
}

function TabBody({ h, tab, sub, go, chartIt, onAccept, accepting }: { h: ChartHeader; tab: TabDef; sub: string | null; go: (t: string, s?: string) => void; chartIt: React.RefObject<ChartItHandle | null>; onAccept: () => void; accepting: boolean }) {
  const props = { h, sub, go }
  switch (tab.key) {
    case 'overview':
      return <Overview h={h} go={go} chartIt={chartIt} onAccept={onAccept} accepting={accepting} notesSlot={(t) => t === 'documents' ? <DocumentsTab h={h} /> : t === 'consent' ? <ConsentTab h={h} /> : t === 'summary' ? <FormPage h={h} formKey="discharge.summary" /> : null} />
    case 'forms': return sub && sub.includes('.') ? <FormPage h={h} formKey={sub} /> : <FormsTab h={h} />
    case 'documents': return <DocumentsTab h={h} />
    case 'consent': return <ConsentTab h={h} />
    case 'cath': return sub ? <SuiteTab {...props} suites={['doctor', 'ot']} /> : <FormPage h={h} formKey="doctor.procedure_note" />
    case 'dietary': return <SuiteTab {...props} suites={['dietary']} />
    case 'doctor': return <DoctorTab {...props} />
    case 'hic': return <HicTab {...props} />
    case 'monitoring': return <MonitoringTab {...props} />
    case 'nursing': return <NursingTab {...props} />
    case 'order_medication': return <MedicationPage h={h} />
    case 'investigations': return <InvestigationsPage h={h} />
    case 'ot': return <OtTab {...props} />
    case 'order_desk': {
      const subs = subsFor(tab, h.permissions)
      const s = sub && subs.some((x) => x.key === sub) ? sub : subs[0]?.key
      switch (s) {
        case 'investigations': return <InvestigationsPage h={h} />
        case 'service-request': return <ServiceRequestPage h={h} />
        case 'medication': return <MedicationPage h={h} />
        case 'pharmacy-return': return <PharmacyReturnPage h={h} />
        case 'procedure': return <ChargePage h={h} kind="procedure" />
        case 'grade-billing': return <ChargePage h={h} kind="grade" />
        case 'equipment': return <EquipmentPage h={h} />
        case 'cancellations': return <CancellationsPage h={h} />
        default: return <Empty icon="Lock" title="Nothing on the order desk for your role" />
      }
    }
    default: return <FormLibrary patientId={h.patient.id} encounterId={h.admission.id} />
  }
}
