import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Avatar, Badge, Button, cn, CopyButton, FieldWrap, Input, MenuItem, Modal, Popover, Switch } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { date, dateTime, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { conditionTone, K, type ChartHeader } from '../api'
import { ConditionPill, PayerChip } from '../ui'

const ALLERGY_ICON: Record<string, string> = {
  Drug: 'Pill', Food: 'Utensils', Contact: 'Hand', Dust: 'Wind', Pollen: 'Flower2', Mould: 'Sprout', Latex: 'HandMetal', 'Insect bite': 'Bug', Skin: 'Scan',
}

function friendly(at?: string | null) {
  if (!at) return ''
  const d = new Date(at)
  const today = new Date()
  return d.toDateString() === today.toDateString() ? `Today, ${time(at)}` : dateTime(at)
}

/** Patient banner: identity, location, payer, consultant, condition (with audit), LOS and the alert cards. */
export function Banner({ h, onRecordObs }: { h: ChartHeader; onRecordObs: () => void }) {
  const a = h.admission
  const p = h.patient
  const perms = h.permissions
  const open = a.status === 'Admitted' || a.status === 'Discharge Initiated'
  const tint = open && a.condition === 'Critical' ? 'border-red-300 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/10'
    : open && a.condition === 'Serious' ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/10' : 'border-line bg-surface'
  const [allergyOpen, setAllergyOpen] = useState(false)
  const [reactiveOpen, setReactiveOpen] = useState(false)
  const statusTone = a.status === 'Admitted' ? 'green' : a.status === 'Discharge Initiated' ? 'amber' : a.status === 'Discharged' ? 'blue' : 'gray'

  return (
    <section className={cn('rounded-xl border p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)]', tint)}>
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 gap-3">
          <Avatar name={p.name} size="lg" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="inline-flex items-center gap-0.5 rounded-md bg-brand-50 px-1.5 py-0.5 font-mono font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200">IP {a.code}<CopyButton value={a.code} label="Copy IP number" /></span>
              <span className="inline-flex items-center gap-0.5 font-mono text-ink-2">UHID {p.uhid}<CopyButton value={p.uhid} label="Copy UHID" /></span>
              <Badge tone={statusTone}>{a.status.toUpperCase()}</Badge>
              {a.mlc && <Badge tone="red">MLC</Badge>}
              {a.isolation && a.isolation !== 'None' && <Badge tone="red"><Icon name="ShieldAlert" className="size-3" /> {a.isolation} precautions</Badge>}
              {a.package_admission && a.package && <Badge tone="violet">Package · {a.package.name}</Badge>}
            </div>
            <h1 className="flex items-center gap-1 text-xl font-semibold tracking-tight text-ink">{p.name}<CopyButton value={p.name} label="Copy name" /></h1>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              <span className="inline-flex items-center gap-1"><Icon name="User" className="size-3.5" />{[p.gender, p.age != null ? `${p.age} yrs` : null].filter(Boolean).join(' · ') || '—'}</span>
              {p.dob && <span className="inline-flex items-center gap-1"><Icon name="Calendar" className="size-3.5" />DOB {date(p.dob)}</span>}
              {p.phone && <span className="inline-flex items-center gap-1"><Icon name="Phone" className="size-3.5" />{p.phone}</span>}
              {p.blood_group && <span className="inline-flex items-center gap-1"><Icon name="Droplet" className="size-3.5" />{p.blood_group}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {h.bed && <Badge tone="gray"><Icon name="BedDouble" className="size-3" /> {h.bed.ward?.toUpperCase()} · Bed {h.bed.bed_no}</Badge>}
              {h.department && <Badge tone="cyan"><Icon name="Building2" className="size-3" /> {h.department.name}</Badge>}
              <PayerChip payer={a.payer} label={a.payer_label} sponsor={a.sponsor?.name} />
              {a.authorisation_no && <Badge tone="gray">Auth {a.authorisation_no}</Badge>}
              {a.approved_amount != null && <Badge tone="gray">Approved ₹{a.approved_amount.toLocaleString('en-IN')}</Badge>}
            </div>
            {a.diagnosis && <p className="text-xs text-ink-2"><span className="text-ink-3">Provisional diagnosis:</span> {a.diagnosis}</p>}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <InfoBlock icon="Stethoscope" label="Primary consultant">
            <div className="truncate font-semibold text-ink">{h.doctor?.name ?? '—'}</div>
            <div className="truncate text-xs text-ink-3">{[h.doctor?.designation, h.second_doctor ? `+ ${h.second_doctor.name}` : null].filter(Boolean).join(' · ')}</div>
          </InfoBlock>
          <InfoBlock icon="HeartPulse" label="Condition">
            <ConditionSelect h={h} />
          </InfoBlock>
          <InfoBlock icon="CalendarDays" label="Length of stay">
            <div className="font-semibold text-ink">{a.los_days === 0 ? 'Admitted today' : `${a.los_days ?? '—'} day${a.los_days === 1 ? '' : 's'}`}</div>
            <div className="text-xs text-ink-3">since {date(a.started_at)}{a.expected_los ? ` · expected ${a.expected_los}d` : ''}</div>
          </InfoBlock>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <AlertCard tone={h.allergies.status === 'present' ? 'red' : h.allergies.status === 'nka' ? 'green' : 'amber'} icon={h.allergies.status === 'nka' ? 'ShieldCheck' : 'TriangleAlert'}
          title={h.allergies.status === 'nka' ? 'No known allergies' : h.allergies.status === 'present' ? 'Allergies' : 'Allergies not recorded'}
          detail={h.allergies.status === 'present' ? [...h.allergies.types, ...h.allergies.list.filter((x) => !h.allergies.types.includes(x))].join(', ') : h.allergies.status === 'nka' ? `Confirmed by ${h.allergies.by ?? '—'}` : 'Ask and record before the first dose'}
          action={perms.clinical ? (h.allergies.status === 'unknown' ? 'Add' : 'Edit') : undefined} onAction={() => setAllergyOpen(true)} />
        <AlertCard tone={h.reactive.status === 'reactive' ? 'red' : h.reactive.status === 'non_reactive' ? 'green' : 'amber'} icon="Shield"
          title={h.reactive.status === 'reactive' ? 'Reactive' : h.reactive.status === 'non_reactive' ? 'Non reactive' : 'Reactive status not recorded'}
          detail={h.reactive.status === 'reactive' ? [...h.reactive.conditions, h.reactive.other].filter(Boolean).join(', ') : h.reactive.status === 'non_reactive' ? `Assessed by ${h.reactive.by ?? '—'}` : 'Tap to record infection precautions'}
          action={perms.clinical && open ? (h.reactive.status === 'unknown' ? 'Add' : 'Edit') : undefined} onAction={() => setReactiveOpen(true)} />
        <AlertCard tone={h.last_obs?.news2 != null && h.last_obs.news2 >= 5 ? 'red' : 'blue'} icon="Clock"
          title={h.last_obs ? 'Last obs' : 'No obs yet'}
          detail={h.last_obs ? `${friendly(h.last_obs.recorded_at)}${h.last_obs.news2 != null ? ` · NEWS2 ${h.last_obs.news2} (${h.last_obs.news2_risk})` : ''}` : 'Chart the first set of observations'}
          action={perms.observe && open ? 'Record' : undefined} onAction={onRecordObs} />
      </div>
      {allergyOpen && <AllergyModal h={h} onClose={() => setAllergyOpen(false)} />}
      {reactiveOpen && <ReactiveModal h={h} onClose={() => setReactiveOpen(false)} />}
    </section>
  )
}

function InfoBlock({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 rounded-lg bg-surface/70 p-2 ring-1 ring-line dark:bg-surface-2/50">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Icon name={icon} className="size-4" /></span>
      <div className="min-w-0 flex-1"><div className="text-[11px] font-medium text-ink-3">{label}</div>{children}</div>
    </div>
  )
}

function AlertCard({ tone, icon, title, detail, action, onAction }: { tone: 'red' | 'green' | 'amber' | 'blue'; icon: string; title: string; detail: string; action?: string; onAction: () => void }) {
  const cls = { red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    blue: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200' }[tone]
  return (
    <div className={cn('flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2', cls)}>
      <Icon name={icon} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="line-clamp-2 text-xs opacity-90">{detail}</div>
      </div>
      {action && <button type="button" onClick={onAction} className="rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide shadow-sm ring-1 ring-current/20 hover:bg-white dark:bg-white/10 dark:hover:bg-white/20">{action}</button>}
    </div>
  )
}

function ConditionSelect({ h }: { h: ChartHeader }) {
  const qc = useQueryClient()
  const a = h.admission
  const [note, setNote] = useState('')
  const can = h.permissions.condition && (a.status === 'Admitted' || a.status === 'Discharge Initiated')
  const save = useMutation({
    mutationFn: (condition: string) => api(`/ipchart/admissions/${a.id}/condition`, { method: 'POST', body: { condition, note: note || null } }),
    onSuccess: (_, c) => { toast.success(`Condition set to ${c}`); setNote(''); qc.invalidateQueries({ queryKey: K.chart(a.id) }); qc.invalidateQueries({ queryKey: ['x', 'ipd'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const by = a.condition_by ? `by ${a.condition_by} · ${a.condition_at ? dateTime(a.condition_at) : ''}` : 'Not assessed yet'
  if (!can) return <div><ConditionPill condition={a.condition} /><div className="mt-0.5 truncate text-[11px] text-ink-3">{by}</div></div>
  return (
    <div>
      <Popover align="left" className="w-72" trigger={({ toggle }) => (
        <button type="button" onClick={toggle} className="inline-flex items-center gap-1" aria-label="Change condition">
          <ConditionPill condition={a.condition} /><Icon name="ChevronDown" className="size-3.5 text-ink-3" />
        </button>
      )}>
        {(close) => (
          <div>
            {h.options.conditions.filter((c) => c !== 'Not assessed').map((c) => (
              <MenuItem key={c} onClick={() => { close(); save.mutate(c) }} hint={c === a.condition ? 'current' : undefined}>
                <Badge tone={conditionTone(c)} dot>{c}</Badge>
              </MenuItem>
            ))}
            <div className="border-t border-line px-3 py-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) e.g. SpO₂ 86% on RA" className="h-8 text-xs" /></div>
            {a.condition_log.length > 0 && (
              <div className="max-h-40 overflow-y-auto border-t border-line px-3 py-2 text-[11px] text-ink-2 scroll-thin">
                {a.condition_log.slice(0, 8).map((l, i) => <div key={i}>{dateTime(l.at)} · {l.previous} → <b>{l.condition}</b> · {l.by}{l.note ? ` — ${l.note}` : ''}</div>)}
              </div>
            )}
          </div>
        )}
      </Popover>
      <div className="mt-0.5 truncate text-[11px] text-ink-3" title={by}>{by}</div>
    </div>
  )
}

function TileToggle({ label, icon, on, onClick, tone }: { label: string; icon?: string; on: boolean; onClick: () => void; tone: 'red' | 'teal' }) {
  const active = tone === 'red' ? 'border-red-400 bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-200' : 'border-teal-500 bg-teal-50 text-teal-800 dark:bg-teal-500/15 dark:text-teal-200'
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cn('flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors', on ? active : 'border-line text-ink-2 hover:bg-surface-2')}>
      {icon && <Icon name={icon} className="size-4" />}{label}{on && <Icon name="Check" className="size-3" />}
    </button>
  )
}

function AllergyModal({ h, onClose }: { h: ChartHeader; onClose: () => void }) {
  const qc = useQueryClient()
  const [nka, setNka] = useState(h.allergies.nka)
  const [types, setTypes] = useState<string[]>(h.allergies.types)
  const [substance, setSubstance] = useState(h.allergies.substance ?? '')
  const save = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${h.admission.id}/allergies`, { method: 'PUT', body: { nka, types: nka ? [] : types, substance: nka ? null : substance || null } }),
    onSuccess: () => { toast.success('Allergies saved'); qc.invalidateQueries({ queryKey: K.chart(h.admission.id) }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const any = nka || types.length > 0 || substance.trim().length > 0
  const summary = nka ? 'No known allergies' : [...types, substance.trim()].filter(Boolean).join(', ')
  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2 text-red-700 dark:text-red-300"><Icon name="TriangleAlert" className="size-5" />Patient allergies</span>}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!any} loading={save.isPending} onClick={() => save.mutate()}>Save allergies</Button></>}>
      <p className="mb-3 text-sm text-ink-2">Tick every kind that applies and name the substance — or confirm there are none. Named substances are checked on every prescription, indent and dispense.</p>
      <label className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
        <span><span className="block text-sm font-medium text-ink">No known allergies</span><span className="text-xs text-ink-3">The patient has been asked and has none.</span></span>
        <Switch checked={nka} onChange={(v) => { setNka(v); if (v) { setTypes([]); setSubstance('') } }} label="No known allergies" />
      </label>
      <div className={cn('grid grid-cols-3 gap-2', nka && 'pointer-events-none opacity-40')}>
        {h.options.allergy_types.map((t) => (
          <TileToggle key={t} label={t} icon={ALLERGY_ICON[t]} tone="red" on={types.includes(t)} onClick={() => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t])} />
        ))}
      </div>
      <FieldWrap label="Other / substance" className="mt-3" help="Separate several with commas">
        <Input value={substance} disabled={nka} onChange={(e) => setSubstance(e.target.value)} placeholder="e.g. Penicillin, peanuts, sulpha drugs" />
      </FieldWrap>
      <p className="mt-3 text-xs text-ink-2">Selected: {any ? <b className="text-ink">{summary}</b> : 'nothing yet — pick a type or switch on "No known allergies"'}</p>
    </Modal>
  )
}

export function ReactiveModal({ h, onClose }: { h: ChartHeader; onClose: () => void }) {
  const qc = useQueryClient()
  const [non, setNon] = useState(h.reactive.status === 'non_reactive')
  const [conds, setConds] = useState<string[]>(h.reactive.conditions)
  const [other, setOther] = useState(h.reactive.other ?? '')
  const save = useMutation({
    mutationFn: () => api<{ isolation_raised?: string | null }>(`/ipchart/admissions/${h.admission.id}/reactive`, { method: 'PUT', body: { non_reactive: non, conditions: non ? [] : conds, other: non ? null : other || null } }),
    onSuccess: (r) => {
      toast.success(r.isolation_raised ? `Reactive status saved · ${r.isolation_raised} precautions raised` : 'Reactive status saved')
      qc.invalidateQueries({ queryKey: K.chart(h.admission.id) }); onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const any = non || conds.length > 0 || other.trim().length > 0
  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2 text-teal-700 dark:text-teal-300"><Icon name="Shield" className="size-5" />Reactive condition</span>}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!any} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <p className="mb-3 text-sm text-ink-2">Tick each infection the ward must take precautions for — or confirm non reactive. Airborne, droplet and contact precautions are raised on the admission automatically.</p>
      <label className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
        <span><span className="block text-sm font-medium text-ink">Non reactive</span><span className="text-xs text-ink-3">Tested or assessed — no infection precautions needed.</span></span>
        <Switch checked={non} onChange={(v) => { setNon(v); if (v) { setConds([]); setOther('') } }} label="Non reactive" />
      </label>
      <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3', non && 'pointer-events-none opacity-40')}>
        {h.options.reactive.map((c) => <TileToggle key={c} label={c} tone="teal" on={conds.includes(c)} onClick={() => setConds(conds.includes(c) ? conds.filter((x) => x !== c) : [...conds, c])} />)}
      </div>
      <FieldWrap label="Other condition" className="mt-3"><Input value={other} disabled={non} onChange={(e) => setOther(e.target.value)} placeholder="Any other reactive condition" /></FieldWrap>
      <p className="mt-3 text-xs text-ink-2">Selected: {any ? <b className="text-ink">{non ? 'Non reactive' : [...conds, other.trim()].filter(Boolean).join(', ')}</b> : 'nothing yet — tick a condition or switch on "Non reactive"'}</p>
      {h.reactive.isolation !== 'None' && <p className="mt-2 text-xs text-red-700 dark:text-red-300">Current precautions: {h.reactive.isolation}</p>}
    </Modal>
  )
}

