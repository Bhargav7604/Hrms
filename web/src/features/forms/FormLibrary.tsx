/** Clinical form library: search, suites with counts, favourites and recent forms; opens the runner on the right. */
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Eye, Search, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, Input, Kbd, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useFormDefs } from './api'
import { FormHistory } from './FormHistory'
import { FormRunner } from './FormRunner'
import { badgeTone } from './logic'
import type { FormContext, FormSummary } from './types'

interface Selection { key: string; recordId?: string }

export function FormLibrary({ patientId, encounterId, suites, initialForm, onSelect, hideOverview }: FormContext & {
  suites?: string[]; initialForm?: string; onSelect?: (formKey: string | null) => void; hideOverview?: boolean
}) {
  const q = useFormDefs(patientId, encounterId)
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [sel, setSel] = useState<Selection | null>(null)
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) { e.preventDefault(); box.current?.focus() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const forms = useMemo(() => {
    const all = q.data?.forms ?? []
    const allowed = suites?.length ? all.filter((f) => [f.suite, ...f.also_in].some((s) => suites.includes(s))) : all.filter((f) => f.suite !== 'op')
    return allowed
  }, [q.data, suites])
  const byKey = useMemo(() => new Map(forms.map((f) => [f.key, f])), [forms])

  const choose = (f: FormSummary, recordId?: string) => {
    const st = f.state
    const rid = recordId ?? st?.draft?.id ?? (f.one_per_admission ? st?.latest?.id : undefined)
    setSel({ key: f.key, recordId: rid })
    onSelect?.(f.key)
  }
  useEffect(() => {
    if (initialForm && !sel && byKey.get(initialForm)) choose(byKey.get(initialForm)!)
  }, [initialForm, byKey])

  const toggleFav = async (key: string) => {
    try {
      const r = await api<{ on: boolean }>(`/forms/favourites/${key}`, { method: 'POST', body: {} })
      toast.success(r.on ? 'Added to favourites' : 'Removed from favourites')
      qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'defs'] })
    } catch (e) { toast.error(errorMessage(e)) }
  }

  if (q.isLoading) return <Spinner label="Loading the form library…" />
  if (q.error) return <ErrorBox error={q.error} />
  const d = q.data!
  const ql = search.trim().toLowerCase()
  const match = (f: FormSummary) => !ql || f.title.toLowerCase().includes(ql) || (f.short ?? '').toLowerCase().includes(ql) || (f.description ?? '').toLowerCase().includes(ql)
  const suiteList = d.suites.filter((s) => forms.some((f) => f.suite === s.id || f.also_in.includes(s.id)))
  const favs = d.favourites.map((k) => byKey.get(k)).filter((f): f is FormSummary => !!f && match(f))
  const recent = d.recent.map((k) => byKey.get(k)).filter((f): f is FormSummary => !!f && match(f) && !d.favourites.includes(f.key)).slice(0, 5)
  const selected = sel ? byKey.get(sel.key) : undefined

  if (!forms.length) return <Empty icon="Lock" title="No clinical forms for your role">Your role does not fill or view any forms in this area.</Empty>

  const Row = ({ f }: { f: FormSummary }) => {
    const fav = d.favourites.includes(f.key)
    const st = f.state
    const active = sel?.key === f.key
    return (
      <div className={cn('group flex items-center gap-1 rounded-lg pr-1', active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
        <button type="button" onClick={() => choose(f)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
          <span className={cn('min-w-0 flex-1 truncate text-sm', active ? 'font-medium text-brand-800 dark:text-brand-200' : 'text-ink')}>{f.title}</span>
          {!f.access.fill && !f.access.sign && <Eye className="size-3.5 shrink-0 text-ink-3" aria-label="View only" />}
          {st?.draft && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Draft in progress" />}
          {st?.latest?.risk_band && <Badge tone={badgeTone(st.latest.risk_tone)} className="px-1 py-0 text-[10px]">{st.latest.score}</Badge>}
          {!st?.latest?.risk_band && st?.latest && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" title="Recorded" />}
        </button>
        <button type="button" onClick={() => void toggleFav(f.key)} aria-label={fav ? 'Remove favourite' : 'Add favourite'} aria-pressed={fav}
          className={cn('rounded p-1', fav ? 'text-amber-500' : 'invisible text-ink-3 hover:text-amber-500 group-hover:visible')}>
          <Star className={cn('size-3.5', fav && 'fill-current')} />
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card pad={false} className="self-start lg:sticky lg:top-2">
        <div className="border-b border-line px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="ClipboardList" className="size-4 text-brand-700 dark:text-brand-300" /> Clinical forms</div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input ref={box} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search forms…" className="pl-8 pr-8"
              onKeyDown={(e) => { if (e.key === 'Escape') setSearch('') }} />
            <span className="absolute right-2 top-2"><Kbd>/</Kbd></span>
          </div>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-2 scroll-thin">
          {favs.length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Favourites</div>
              {favs.map((f) => <Row key={f.key} f={f} />)}
            </div>
          )}
          {recent.length > 0 && !ql && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Recent</div>
              {recent.map((f) => <Row key={f.key} f={f} />)}
            </div>
          )}
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">All forms</div>
          {suiteList.map((s) => {
            const list = forms.filter((f) => (f.suite === s.id || f.also_in.includes(s.id)) && match(f))
              .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.order - b.order)
            if (!list.length) return null
            const expanded = ql ? true : open[s.id] ?? (suiteList.length <= 2 || s.id === (selected?.suite ?? suiteList[0]?.id))
            return (
              <div key={s.id} className="mb-0.5">
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [s.id]: !expanded }))} aria-expanded={expanded}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-ink hover:bg-surface-2">
                  <Icon name={s.icon} className="size-4 text-ink-3" />
                  <span className="flex-1">{s.name}</span>
                  <span className="text-xs tabular text-ink-3">{list.length}</span>
                  {expanded ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
                </button>
                {expanded && <div className="ml-3 border-l border-line pl-1">{list.map((f) => <Row key={`${s.id}-${f.key}`} f={f} />)}</div>}
              </div>
            )
          })}
          {ql && !forms.some(match) && <p className="px-2 py-4 text-center text-xs text-ink-3">No form matches “{search}”.</p>}
        </div>
      </Card>

      <div className="min-w-0 space-y-3">
        {selected && (
          <SelectionBar f={selected} current={sel?.recordId} onPick={(rid) => setSel({ key: selected.key, recordId: rid })} />
        )}
        {selected ? (
          <FormRunner key={selected.key} formKey={selected.key} recordId={sel?.recordId} patientId={patientId} encounterId={encounterId}
            onSaved={(id) => { setSel((s) => (s ? { ...s, recordId: id } : s)); qc.invalidateQueries({ queryKey: ['x', 'emr', 'forms', 'defs'] }) }}
            onClose={() => { setSel(null); onSelect?.(null) }} />
        ) : hideOverview ? (
          <Card><Empty icon="ClipboardList" title="Pick a form">Choose a form on the left — search with <Kbd>/</Kbd>, star the ones you use most.</Empty></Card>
        ) : (
          <Card title="Recent forms for this patient" icon="History">
            <FormHistory patientId={patientId} encounterId={encounterId} limit={12}
              onOpen={(r) => { const f = byKey.get(r.form_key); if (f) setSel({ key: f.key, recordId: r.id }) }} />
          </Card>
        )}
      </div>
    </div>
  )
}

function SelectionBar({ f, current, onPick }: { f: FormSummary; current?: string; onPick: (recordId?: string) => void }) {
  const st = f.state
  if (!st || (!st.draft && !st.latest)) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
      <span>{st.count} entr{st.count === 1 ? 'y' : 'ies'} for this {f.one_per_admission ? 'admission' : 'patient'}</span>
      {st.draft && st.draft.id !== current && <Button size="xs" icon="Pencil" onClick={() => onPick(st.draft!.id)}>Continue draft · {dateTime(st.draft.updated_at)}</Button>}
      {st.latest && st.latest.id !== current && <Button size="xs" icon="Eye" onClick={() => onPick(st.latest!.id)}>View last signed · {dateTime(st.latest.noted_at)}</Button>}
      {!f.one_per_admission && f.access.fill && current && <Button size="xs" variant="primary" icon="Plus" onClick={() => onPick(undefined)}>Start new</Button>}
      {st.latest?.risk_band && <Badge tone={badgeTone(st.latest.risk_tone)}>Last: {st.latest.score} · {st.latest.risk_band}</Badge>}
    </div>
  )
}
