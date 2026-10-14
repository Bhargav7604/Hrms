import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { useEntity } from '@/components/records'
import { Badge, Button, Empty, ErrorBox, FieldWrap, Input, Segmented, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, apiUrl, errorMessage, uploadFile } from '@/lib/api'
import { date, dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K, type ChartHeader } from '../api'
import { Section, Table, td } from '../ui'

interface Doc { id: string; code: string; category: string; document_name: string; document_date?: string; file?: string; status: string; created_at: string; created_by?: string; confidential?: boolean }

/** Documents for this admission, uploaded by category. */
export function DocumentsTab({ h }: { h: ChartHeader }) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const ent = useEntity('documents.documents')
  const cats = ent?.fields.find((f) => f.key === 'category')?.options ?? ['Other']
  const [category, setCategory] = useState('Other')
  const [name, setName] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const canWrite = h.permissions.documents
  const list = useQuery({ queryKey: ['x', 'documents', 'ipchart', aid], queryFn: () => api<{ rows: Doc[] }>('/m/documents/documents', { query: { encounter_id: aid, limit: 200 } }) })
  const up = useMutation({
    mutationFn: async (f: File) => {
      const u = await uploadFile(f, h.patient.id)
      return api('/m/documents/documents', { method: 'POST', body: { patient_id: h.patient.id, encounter_id: aid, category, document_name: name.trim() || f.name, file: u.id, source: 'Scanned at desk', document_date: new Date().toISOString().slice(0, 10) } })
    },
    onSuccess: () => { toast.success('Document attached'); setName(''); qc.invalidateQueries({ queryKey: ['x', 'documents', 'ipchart', aid] }); qc.invalidateQueries({ queryKey: K.chart(aid) }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Section title="Documents" icon="FileText" tone="blue" subtitle="Uploaded documents for this admission — ID proofs, insurance papers, outside reports, scanned consents.">
      {canWrite && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <FieldWrap label="Category" className="w-60"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{cats.map((c) => <option key={c}>{c}</option>)}</Select></FieldWrap>
          <FieldWrap label="Document name" className="min-w-60 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the file name" /></FieldWrap>
          <input ref={file} type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); e.target.value = '' }} />
          <Button icon="Upload" loading={up.isPending} onClick={() => file.current?.click()}>Attach file</Button>
        </div>
      )}
      {list.isLoading ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.rows.length ? <Empty icon="FileText" title="No documents attached" /> : (
        <Table head={['Document', 'Category', 'Date', 'Status', '']}>
          {list.data.rows.map((d) => (
            <tr key={d.id} className="border-t border-line">
              <td className={td}><span className="font-medium text-ink">{d.document_name}</span> {d.confidential && <Badge tone="red">Sensitive</Badge>}<div className="text-xs text-ink-3">{d.code} · added {dateTime(d.created_at)}</div></td>
              <td className={td}>{d.category}</td>
              <td className={td}>{date(d.document_date)}</td>
              <td className={td}><StatusBadge status={d.status} /></td>
              <td className={`${td} text-right`}>{d.file && <a className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-300" href={apiUrl(`/files/${d.file}`, {}, true)} target="_blank" rel="noreferrer"><Icon name="ExternalLink" className="size-3.5" />Open</a>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}

interface ConsentRow {
  id: string; code: string; status: string; taken: boolean; consent_type?: string; template?: string; procedure?: string; signer_name?: string; relationship?: string
  witness?: string; explained_by?: string; language?: string; risks?: string; benefits?: string; alternatives?: string; remarks?: string; signed_at?: string
  recorded_by?: string; recorded_at?: string
}
interface ConsentData { rows: ConsentRow[]; templates: { id: string; name: string; consent_type: string; version: string }[]; types: string[]; relationships: string[]; languages: string[] }

/** Structured consent recording (taken / not taken) stored in Consent Management, with print. */
export function ConsentTab({ h }: { h: ChartHeader }) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const q = useQuery({ queryKey: K.consents(aid), queryFn: () => api<ConsentData>(`/ipchart/admissions/${aid}/consents`) })
  const form = useRef<HTMLDivElement>(null)
  const blank = { taken: 'taken' as 'taken' | 'not', template_id: '', consent_type: 'General', procedure: '', signer_name: h.patient.name.replace(/^(Mr|Mrs|Ms|Master|Baby)\.?\s+/i, ''), relationship: 'Self', witness: '', explained_by: null as string | null, language: 'English', risks: '', benefits: '', alternatives: '', remarks: '' }
  const [f, setF] = useState(blank)
  const set = <T extends keyof typeof f>(k: T, v: (typeof f)[T]) => setF((x) => ({ ...x, [k]: v }))
  const save = useMutation({
    mutationFn: () => api<{ code: string }>(`/ipchart/admissions/${aid}/consents`, {
      method: 'POST',
      body: { taken: f.taken === 'taken', template_id: f.template_id || null, consent_type: f.consent_type || null, procedure: f.procedure || null, signer_name: f.signer_name, relationship: f.relationship,
        witness: f.witness || null, explained_by: f.explained_by, language: f.language, risks: f.risks || null, benefits: f.benefits || null, alternatives: f.alternatives || null, remarks: f.remarks || null },
    }),
    onSuccess: (r) => { toast.success(`Consent recorded · ${r.code}`); setF(blank); qc.invalidateQueries({ queryKey: K.consents(aid) }); qc.invalidateQueries({ queryKey: K.chart(aid) }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const d = q.data
  const print = (id: string) => window.open(`/print/consents/consents/${id}`, '_blank')
  return (
    <div className="space-y-4">
      <Section title="Consents" icon="ShieldCheck" tone="teal" subtitle="Recorded patient consents for this admission."
        actions={<>
          {d && d.rows.length > 0 && <Button size="sm" icon="Printer" onClick={() => print(d.rows[0].id)}>Print latest consent</Button>}
          {h.permissions.consent && <Button size="sm" variant="primary" icon="Plus" onClick={() => form.current?.scrollIntoView({ behavior: 'smooth' })}>Grant consent</Button>}
        </>} pad={false}>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !d?.rows.length ? (
          <Empty icon="ShieldCheck" title="No consents recorded yet">Grant or print a patient consent to manage legal documentation.</Empty>
        ) : (
          <Table head={['Consent', 'Signatory', 'Explained by', 'Language', 'Recorded', '']}>
            {d.rows.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className={td}><span className="font-medium text-ink">{c.consent_type}</span>{c.procedure && <span className="text-ink-2"> · {c.procedure}</span>}
                  <div className="mt-0.5 flex items-center gap-1"><Badge tone={c.taken ? 'green' : 'amber'}>{c.taken ? 'Consent taken' : 'Not taken'}</Badge><span className="text-xs text-ink-3">{c.code} · {c.template}</span></div>
                  {!c.taken && c.remarks && <div className="text-xs text-amber-700 dark:text-amber-300">{c.remarks}</div>}</td>
                <td className={td}>{c.signer_name}<div className="text-xs text-ink-3">{c.relationship}{c.witness ? ` · witness ${c.witness}` : ''}</div></td>
                <td className={td}>{c.explained_by ?? '—'}</td>
                <td className={td}>{c.language ?? '—'}</td>
                <td className={td}><span className="text-xs">{dateTime(c.signed_at ?? c.recorded_at)}</span><div className="text-xs text-ink-3">{c.recorded_by}</div></td>
                <td className={`${td} text-right`}><Button size="xs" variant="ghost" icon="Printer" onClick={() => print(c.id)}>Print</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {h.permissions.consent && d && (
        <div ref={form}>
          <Section title="Record a consent" icon="FilePen" tone="indigo">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FieldWrap label="Consent status"><Segmented value={f.taken} onChange={(v) => set('taken', v)} options={[{ key: 'taken', label: 'Consent taken' }, { key: 'not', label: 'No consent taken' }]} /></FieldWrap>
              <FieldWrap label="Consent type" required>
                <Select value={f.template_id ? `t:${f.template_id}` : `c:${f.consent_type}`} onChange={(e) => {
                  const [k, v] = [e.target.value.slice(0, 1), e.target.value.slice(2)]
                  if (k === 't') { const t = d.templates.find((x) => x.id === v); setF((x) => ({ ...x, template_id: v, consent_type: t?.consent_type ?? x.consent_type })) } else setF((x) => ({ ...x, template_id: '', consent_type: v }))
                }}>
                  {d.templates.length > 0 && <optgroup label="Templates">{d.templates.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name} (v{t.version})</option>)}</optgroup>}
                  <optgroup label="Consent types">{d.types.map((t) => <option key={t} value={`c:${t}`}>{t}</option>)}</optgroup>
                </Select>
              </FieldWrap>
              <FieldWrap label="Procedure"><Input value={f.procedure} onChange={(e) => set('procedure', e.target.value)} placeholder="Optional" /></FieldWrap>
              <FieldWrap label="Signatory name" required><Input value={f.signer_name} onChange={(e) => set('signer_name', e.target.value)} /></FieldWrap>
              <FieldWrap label="Relationship"><Select value={f.relationship} onChange={(e) => set('relationship', e.target.value)}>{d.relationships.map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
              <FieldWrap label="Witness"><Input value={f.witness} onChange={(e) => set('witness', e.target.value)} placeholder="Name of the witness" /></FieldWrap>
              <FieldWrap label="Explaining doctor"><RefPicker refName="employees.employees" kind="doctor" filter={{ category: 'Doctor' }} value={f.explained_by} onChange={(v) => set('explained_by', v)} placeholder="Defaults to you if you are a doctor" /></FieldWrap>
              <FieldWrap label="Language"><Select value={f.language} onChange={(e) => set('language', e.target.value)}>{d.languages.map((l) => <option key={l}>{l}</option>)}</Select></FieldWrap>
              <FieldWrap label="Risks explained"><Textarea rows={2} value={f.risks} onChange={(e) => set('risks', e.target.value)} placeholder="Optional" /></FieldWrap>
              <FieldWrap label="Benefits explained"><Textarea rows={2} value={f.benefits} onChange={(e) => set('benefits', e.target.value)} placeholder="Optional" /></FieldWrap>
              <FieldWrap label="Alternatives explained"><Textarea rows={2} value={f.alternatives} onChange={(e) => set('alternatives', e.target.value)} placeholder="Optional" /></FieldWrap>
              <FieldWrap label="Remarks" required={f.taken === 'not'} help={f.taken === 'not' ? 'Why consent was not taken' : undefined}><Textarea rows={2} value={f.remarks} onChange={(e) => set('remarks', e.target.value)} /></FieldWrap>
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="primary" icon="ShieldCheck" disabled={f.signer_name.trim().length < 2 || (f.taken === 'not' && !f.remarks.trim())} loading={save.isPending} onClick={() => save.mutate()}>
                {f.taken === 'taken' ? 'Grant consent' : 'Record refusal'}
              </Button>
            </div>
          </Section>
        </div>
      )}
    </div>
  )
}
