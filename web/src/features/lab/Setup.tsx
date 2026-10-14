import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Empty, Tabs } from '@/components/ui'
import { EntityView } from '@/components/records'
import { useRegistry } from '@/lib/auth'
import { LabShell } from './shell'

const SETUP: { key: string; label: string; icon: string; hint: string }[] = [
  { key: 'sections', label: 'Sections', icon: 'LayoutList', hint: 'Bench sections, report headings and section heads' },
  { key: 'analyzers', label: 'Analysers', icon: 'Cpu', hint: 'Instruments, interface protocol and calibration' },
  { key: 'ref_ranges', label: 'Reference ranges', icon: 'Ruler', hint: 'Normal and critical limits by age band and sex' },
  { key: 'reflex_rules', label: 'Reflex rules', icon: 'GitBranchPlus', hint: 'When a result meets a condition, suggest or auto-order another test' },
  { key: 'delta_rules', label: 'Delta checks', icon: 'Activity', hint: 'Maximum change from the previous result; optionally hold authorisation' },
  { key: 'report_templates', label: 'Report formats', icon: 'FileText', hint: 'Layout, signatories, header note and footer per section' },
  { key: 'antibiotics', label: 'Antibiotic panels', icon: 'Pill', hint: 'Antibiotics per sensitivity panel for microbiology' },
  { key: 'reference_labs', label: 'Reference labs', icon: 'Building2', hint: 'Out-sourcing partners, accreditation and turnaround' },
  { key: 'tests', label: 'Test catalogue', icon: 'BookOpen', hint: 'Tests, parameters, sample and rates' },
  { key: 'qc_runs', label: 'Quality control', icon: 'ChartLine', hint: 'Daily QC runs and Westgard results' },
]

export default function LabSetup() {
  const reg = useRegistry()
  const [params, setParams] = useSearchParams()
  const tabs = SETUP.filter((s) => reg.canEntity(`lab.${s.key}`))
  const [tab, setTab] = useState(() => params.get('tab') ?? tabs[0]?.key ?? 'sections')
  const active = tabs.find((t) => t.key === tab) ?? tabs[0]
  const ent = active ? reg.entity(`lab.${active.key}`) : undefined
  return (
    <LabShell screen="setup" icon="Settings2" title="Lab setup" subtitle="Masters that drive the laboratory screens: sections, analysers, reference ranges by age and sex, reflex and delta rules, report formats, antibiotic panels and reference labs.">
      {tabs.length === 0 ? <Empty icon="Lock" title="No setup records for your role" /> : (
        <>
          <Tabs className="mb-3" value={active.key} onChange={(k) => { setTab(k); setParams({ tab: k }, { replace: true }) }} tabs={tabs.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))} />
          <p className="mb-3 text-sm text-ink-2">{active.hint}</p>
          {ent && <EntityView key={ent.fqn} entity={ent} />}
        </>
      )}
    </LabShell>
  )
}
