import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, MenuItem, Popover, Segmented, Spinner, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K } from '../api'

interface NoteRow { id: string; code: string; note_type: string; noted_at: string; author?: string; author_role?: string; shift?: string | null; specialty?: string | null; note: string; status: string }
type Shift = 'Morning' | 'Evening' | 'Night'

export function currentShift(): Shift {
  const h = new Date().getHours()
  return h >= 8 && h < 14 ? 'Morning' : h >= 14 && h < 20 ? 'Evening' : 'Night'
}

type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }

/** Browser speech-to-text (Chrome / Edge); returns null when the browser has none. */
export function useDictation(onText: (t: string) => void) {
  const Ctor = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
    ?? (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition
  const [on, setOn] = useState(false)
  const rec = useRef<Recognition | null>(null)
  const cb = useRef(onText)
  cb.current = onText
  useEffect(() => () => rec.current?.stop(), [])
  if (!Ctor) return null
  const toggle = () => {
    if (on) { rec.current?.stop(); return }
    const r = new Ctor()
    r.lang = 'en-IN'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) cb.current(e.results[i][0].transcript.trim())
    }
    r.onend = () => setOn(false)
    r.onerror = () => { setOn(false); toast.error('Dictation stopped — check microphone permission') }
    rec.current = r
    r.start()
    setOn(true)
  }
  return { on, toggle }
}

export function DictateButton({ onText }: { onText: (t: string) => void }) {
  const d = useDictation(onText)
  if (!d) return null
  return (
    <Button type="button" size="xs" variant={d.on ? 'danger' : 'ghost'} onClick={d.toggle} title={d.on ? 'Stop dictation' : 'Dictate (speech to text)'} aria-pressed={d.on}>
      <Icon name={d.on ? 'MicOff' : 'Mic'} className="size-3.5" /> {d.on ? 'Listening…' : 'Dictate'}
    </Button>
  )
}

export function TemplatesButton({ kind, onPick }: { kind: 'clinical' | 'nursing'; onPick: (text: string) => void }) {
  const q = useQuery({ queryKey: ['x', 'ipd', 'note-templates', kind], queryFn: () => api<{ templates: { name: string; text: string }[] }>('/ipchart/note-templates', { query: { kind } }), staleTime: 600_000 })
  return (
    <Popover className="w-72" trigger={({ toggle }) => <Button type="button" size="xs" variant="ghost" onClick={toggle}><Icon name="FileText" className="size-3.5" /> Templates</Button>}>
      {(close) => (q.data?.templates ?? []).map((t) => <MenuItem key={t.name} onClick={() => { close(); onPick(t.text) }}>{t.name}</MenuItem>)}
    </Popover>
  )
}

/** Progress notes by shift (doctor) or nursing notes — add form with templates and dictation, then the signed list. */
export function ProgressNotes({ aid, kind, canWrite, defaultSpecialty }: { aid: string; kind: 'clinical' | 'nursing'; canWrite: boolean; defaultSpecialty?: string | null }) {
  const qc = useQueryClient()
  const [shift, setShift] = useState<Shift>(currentShift())
  const [filter, setFilter] = useState<'all' | Shift>('all')
  const [specialty, setSpecialty] = useState(defaultSpecialty ?? '')
  const [note, setNote] = useState('')
  const list = useQuery({ queryKey: K.notes(aid, kind), queryFn: () => api<{ rows: NoteRow[] }>(`/ipchart/admissions/${aid}/notes`, { query: { kind } }) })
  const add = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${aid}/notes`, { method: 'POST', body: { kind, shift, specialty: specialty || null, note } }),
    onSuccess: () => { toast.success(kind === 'clinical' ? 'Progress note added' : 'Nursing note added'); setNote(''); qc.invalidateQueries({ queryKey: ['x', 'emr', 'ipchart', aid] }); qc.invalidateQueries({ queryKey: K.chart(aid) }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = (list.data?.rows ?? []).filter((r) => filter === 'all' || r.shift === filter)
  const append = (t: string) => setNote((n) => (n ? `${n}${n.endsWith('\n') ? '' : '\n'}${t}` : t))
  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="rounded-lg border border-line p-3">
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="NotebookPen" className="size-4 text-brand-700 dark:text-brand-300" />{kind === 'clinical' ? 'Add progress note' : 'Add nursing note'}</h4>
          <div className="flex flex-wrap items-end gap-3">
            <FieldWrap label="Shift"><Segmented value={shift} onChange={setShift} options={(['Morning', 'Evening', 'Night'] as Shift[]).map((s) => ({ key: s, label: s }))} /></FieldWrap>
            {kind === 'clinical' && <FieldWrap label="Speciality / dept" className="w-56"><Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} /></FieldWrap>}
          </div>
          <FieldWrap label="Note" className="mt-2">
            <div className="relative">
              <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'clinical' ? 'Write the progress note…' : 'Write the nursing note…'}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim().length >= 3) add.mutate() }} />
              <div className="absolute right-2 top-2 flex gap-1"><TemplatesButton kind={kind} onPick={append} /><DictateButton onText={append} /></div>
            </div>
          </FieldWrap>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-ink-3">Saved and signed under your name · Ctrl/⌘+Enter</span>
            <Button variant="primary" size="sm" disabled={note.trim().length < 3} loading={add.isPending} onClick={() => add.mutate()}>Add note</Button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{kind === 'clinical' ? 'Clinical notes' : 'Nursing notes'} {list.data && `· ${list.data.rows.length}`}</h4>
        <Segmented value={filter} onChange={setFilter} options={[{ key: 'all', label: 'All' }, { key: 'Morning', label: 'Morning' }, { key: 'Evening', label: 'Evening' }, { key: 'Night', label: 'Night' }]} />
      </div>
      {list.isLoading ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : rows.length === 0 ? <Empty icon="NotebookPen" title="No notes written yet" /> : (
        <ol className="space-y-2">
          {rows.map((n) => (
            <li key={n.id} className="rounded-lg border border-line p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="font-medium text-ink">{n.author ?? '—'}</span>
                {n.shift && <Badge tone={n.shift === 'Night' ? 'violet' : n.shift === 'Evening' ? 'amber' : 'cyan'}>{n.shift}</Badge>}
                {n.specialty && <Badge tone="gray">{n.specialty}</Badge>}
                <span>{n.note_type}</span><span>·</span><span>{dateTime(n.noted_at)}</span>
                <Badge tone={n.status === 'Draft' ? 'amber' : 'green'} className="ml-auto">{n.status}</Badge>
              </div>
              <p className={cn('whitespace-pre-wrap text-sm text-ink')}>{n.note}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
