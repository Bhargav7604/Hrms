import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, Empty, FieldWrap, Input, PageHeader, Spinner, Switch } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { ErSettings } from './api'
import { ACTIONS } from './ui'

const STEPS = [['orders', 'Orders / indents'], ['treatment', 'Treatment & reassessment'], ['nursing_assessment', 'Nursing assessment'], ['doctor_assignment', 'Doctor assignment']]
const COLUMNS = ['sno', 'bed', 'er_no', 'bill_no', 'patient', 'age_sex', 'arrived', 'time_in_er', 'triage', 'doctor', 'current_step', 'mlc', 'status']
const REQ_FIELDS = ['condition_at_disposition', 'disposition_notes', 'followup_advice', 'referred_to', 'transfer_reason', 'transport_mode', 'lama_reason',
  'consent_by', 'risks_explained', 'time_of_death', 'cause_of_death', 'absconded_noticed_at', 'security_informed']

/** ER settings (namespace `er`, organisation scope): flow, triage, board, registration and disposition rules. */
export default function ErSettingsPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const defaults = useQuery({ queryKey: ['x', 'er', 'settings-defaults'], queryFn: () => api<ErSettings>('/er/settings/defaults') })
  const eff = useQuery({ queryKey: ['x', 'er', 'settings'], queryFn: () => api<ErSettings>('/er/settings/effective') })
  const [s, setS] = useState<ErSettings | null>(null)
  useEffect(() => { if (eff.data && !s) setS(structuredClone(eff.data)) }, [eff.data, s])
  const save = useMutation({
    mutationFn: () => api('/settings/er', { method: 'PUT', body: { scope: 'org', values: s } }),
    onSuccess: () => { toast.success('ER settings saved'); qc.invalidateQueries({ queryKey: ['x', 'er'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reset = useMutation({
    mutationFn: () => api('/settings/er', { method: 'DELETE', query: { scope: 'org' } }),
    onSuccess: () => { toast.success('Defaults restored'); setS(structuredClone(defaults.data!)); qc.invalidateQueries({ queryKey: ['x', 'er'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (user && user.role !== 'admin') return <Empty icon="Lock" title="ER settings are managed by the administrator" />
  if (!s) return <Spinner />
  const up = (fn: (x: ErSettings) => void) => setS((cur) => { const n = structuredClone(cur!); fn(n); return n })
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k])
  return (
    <div className="space-y-4">
      <PageHeader icon="Settings2" title="ER settings" subtitle="Organisation-wide rules for the emergency workflow, triage targets, boards and disposition."
        actions={<>
          <Button size="sm" variant="ghost" loading={reset.isPending} onClick={() => reset.mutate()}>Reset to defaults</Button>
          <Button size="sm" variant="primary" icon="Save" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon="Workflow" title="Flow & settings">
          <p className="mb-2 text-xs font-medium text-ink-2">Optional workflow steps (not required for "Now")</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {STEPS.map(([k, label]) => (
              <label key={k} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm ring-1 ring-line">{label}
                <Switch size="sm" checked={s.flow.optional_steps.includes(k)} onChange={() => up((x) => { x.flow.optional_steps = toggle(x.flow.optional_steps, k) })} label={label} /></label>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <FieldWrap label="ER length-of-stay target (min)"><Input type="number" min={30} value={s.flow.los_target_minutes} onChange={(e) => up((x) => { x.flow.los_target_minutes = Number(e.target.value) })} /></FieldWrap>
            <FieldWrap label="Doctor pool (department codes)"><Input value={s.flow.doctor_departments.join(', ')} onChange={(e) => up((x) => { x.flow.doctor_departments = e.target.value.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean) })} /></FieldWrap>
            <FieldWrap label="Observation charge code"><Input value={s.flow.observation_charge_code} onChange={(e) => up((x) => { x.flow.observation_charge_code = e.target.value })} /></FieldWrap>
            <FieldWrap label="Observation block (hours)"><Input type="number" min={1} value={s.flow.observation_block_hours} onChange={(e) => up((x) => { x.flow.observation_block_hours = Number(e.target.value) })} /></FieldWrap>
          </div>
          {([['auto_assign_doctor', 'Auto-assign the least-loaded doctor at registration'], ['carry_charges_to_admission', 'Move unbilled ER charges to the IP bill on admission'],
            ['auto_close_on_admission', 'Close admitted visits automatically when nothing is left to bill']] as const).map(([k, label]) => (
            <label key={k} className="mt-2 flex items-center justify-between text-sm text-ink">{label}
              <Switch size="sm" checked={!!s.flow[k]} onChange={(c) => up((x) => { x.flow[k] = c })} label={label} /></label>
          ))}
        </Card>
        <Card icon="Siren" title="Triage levels & target times">
          <div className="space-y-2">
            {s.triage.levels.map((l, i) => (
              <div key={l.key} className="grid items-end gap-2 sm:grid-cols-[1fr_70px_110px_auto]">
                <FieldWrap label={i === 0 ? 'Label' : undefined}><Input value={l.label} onChange={(e) => up((x) => { x.triage.levels[i].label = e.target.value })} /></FieldWrap>
                <FieldWrap label={i === 0 ? 'Priority' : undefined}><Input value={l.priority ?? ''} onChange={(e) => up((x) => { x.triage.levels[i].priority = e.target.value || null })} /></FieldWrap>
                <FieldWrap label={i === 0 ? 'Target (min)' : undefined}><Input type="number" min={0} value={l.target_minutes ?? ''} placeholder="none"
                  onChange={(e) => up((x) => { x.triage.levels[i].target_minutes = e.target.value === '' ? null : Number(e.target.value) })} /></FieldWrap>
                <Switch checked={l.enabled !== false} onChange={(c) => up((x) => { x.triage.levels[i].enabled = c })} label={`${l.label} enabled`} />
              </div>
            ))}
          </div>
        </Card>
        <Card icon="LayoutGrid" title="Board columns & actions">
          <p className="mb-2 text-xs font-medium text-ink-2">Ward-board action icons</p>
          <div className="flex flex-wrap gap-1.5">
            {ACTIONS.map((a) => <Chip key={a.key} on={s.board.actions.includes(a.key)} onClick={() => up((x) => { x.board.actions = toggle(x.board.actions, a.key) })}>{a.label}</Chip>)}
          </div>
          <p className="mb-2 mt-4 text-xs font-medium text-ink-2">Tracking-board columns (default; users can personalise)</p>
          <div className="flex flex-wrap gap-1.5">
            {COLUMNS.map((c) => <Chip key={c} on={s.board.columns.includes(c)} onClick={() => up((x) => { x.board.columns = toggle(x.board.columns, c) })}>{c.replace(/_/g, ' ')}</Chip>)}
          </div>
          <FieldWrap label="Board refresh (seconds)" className="mt-3 w-48"><Input type="number" min={15} value={s.board.refresh_seconds} onChange={(e) => up((x) => { x.board.refresh_seconds = Number(e.target.value) })} /></FieldWrap>
        </Card>
        <Card icon="LogOut" title="Disposition — required fields">
          <div className="space-y-3">
            {Object.entries(s.disposition.types).map(([t, cfg]) => (
              <div key={t}>
                <label className="flex items-center justify-between text-sm font-medium text-ink">{t}
                  <Switch size="sm" checked={cfg.enabled} onChange={(c) => up((x) => { x.disposition.types[t].enabled = c })} label={`${t} enabled`} /></label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {REQ_FIELDS.map((k) => <Chip key={k} small on={cfg.required.includes(k)} onClick={() => up((x) => { x.disposition.types[t].required = toggle(x.disposition.types[t].required, k) })}>{k.replace(/_/g, ' ')}</Chip>)}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card icon="UserPlus" title="Registration">
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldWrap label="Default arrival mode"><Input value={s.registration.default_arrival_mode} onChange={(e) => up((x) => { x.registration.default_arrival_mode = e.target.value })} /></FieldWrap>
            <FieldWrap label="Default payer"><Input value={s.registration.default_payer} onChange={(e) => up((x) => { x.registration.default_payer = e.target.value })} /></FieldWrap>
            <FieldWrap label="Arrival modes that are MLC by default"><Input value={s.registration.mlc_arrival_modes.join(', ')} onChange={(e) => up((x) => { x.registration.mlc_arrival_modes = e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></FieldWrap>
            <label className="flex items-center justify-between text-sm text-ink">Bed required at registration<Switch size="sm" checked={s.registration.require_bed} onChange={(c) => up((x) => { x.registration.require_bed = c })} label="Bed required" /></label>
          </div>
        </Card>
        <Card icon="FileText" title="Documents, alerts & handover">
          <FieldWrap label="Document categories (comma separated)"><Input value={s.documents.categories.join(', ')} onChange={(e) => up((x) => { x.documents.categories = e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></FieldWrap>
          <FieldWrap label="Clinical alert options" className="mt-3"><Input value={s.alerts.join(', ')} onChange={(e) => up((x) => { x.alerts = e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></FieldWrap>
          <FieldWrap label="Handover shifts (name@HH:MM)" className="mt-3">
            <Input value={s.handover.shifts.map((x) => `${x.key}@${x.start}`).join(', ')}
              onChange={(e) => up((x) => { x.handover.shifts = e.target.value.split(',').map((v) => v.trim()).filter(Boolean).map((v) => ({ key: v.split('@')[0], start: v.split('@')[1] ?? '08:00' })) })} />
          </FieldWrap>
        </Card>
      </div>
    </div>
  )
}

function Chip({ on, onClick, children, small }: { on: boolean; onClick: () => void; children: React.ReactNode; small?: boolean }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`rounded-full ring-1 ${small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'} ${on ? 'bg-brand-700 text-white ring-brand-800' : 'bg-surface-2 text-ink-2 ring-line'}`}>
      {children}
    </button>
  )
}
