import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, ErrorBox, Modal, Spinner, StatusBadge } from '@/components/ui'
import { api, apiUrl, errorMessage, uploadFile } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { K, type DocType } from './api'

interface DocsData {
  types: DocType[]; patient_id: string; can_upload: boolean
  documents: { id: string; code: string; type: string; category: string; name: string; file: string; status: string; uploaded_at: string; mime: string | null; size: number | null }[]
}

const MIME: Record<string, string[]> = {
  JPG: ['image/jpeg'], JPEG: ['image/jpeg'], PNG: ['image/png'], PDF: ['application/pdf'], TIFF: ['image/tiff'], WEBP: ['image/webp'], HEIC: ['image/heic'],
}

/** Upload discharge documents; types, accepted formats and size limits come from the IP-billing settings. */
export function DocumentsModal({ admissionId, patientName, onClose }: { admissionId: string; patientName: string; onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: K.docs(admissionId), queryFn: () => api<DocsData>(`/ipbilling/admissions/${admissionId}/documents`) })
  const input = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState<DocType | null>(null)
  const up = useMutation({
    mutationFn: async ({ t, file }: { t: DocType; file: File }) => {
      const okTypes = t.formats.flatMap((f) => MIME[f.toUpperCase()] ?? [])
      if (okTypes.length && !okTypes.includes(file.type)) throw new Error(`${t.label}: only ${t.formats.join(', ')} files are accepted`)
      if (file.size > t.max_mb * 1024 * 1024) throw new Error(`${t.label}: the file is larger than ${t.max_mb} MB`)
      const f = await uploadFile(file, q.data?.patient_id)
      return api(`/ipbilling/admissions/${admissionId}/documents`, { method: 'POST', body: { type: t.key, file_id: f.id, name: `${t.label} — ${file.name}`.slice(0, 200) } })
    },
    onSuccess: () => { toast.success('Document uploaded'); qc.invalidateQueries({ queryKey: K.docs(admissionId) }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2"><Paperclip className="size-4" />Documents · {patientName}</span>} size="md">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : q.data && (
        <div className="space-y-2">
          <input ref={input} type="file" className="hidden" accept={target ? target.formats.map((f) => `.${f.toLowerCase()}`).join(',') : undefined}
            onChange={(e) => { const file = e.target.files?.[0]; if (file && target) up.mutate({ t: target, file }); e.target.value = '' }} />
          {q.data.types.map((t) => {
            const docs = q.data.documents.filter((d) => d.type === t.key)
            return (
              <div key={t.key} className="rounded-lg border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2"><Paperclip className="size-4 text-ink-3" />
                    <span><span className="block text-sm font-medium text-ink">{t.label}</span><span className="block text-xs text-ink-3">{t.formats.join(', ')} · max {t.max_mb} MB</span></span>
                  </span>
                  {q.data.can_upload && (
                    <Button size="sm" loading={up.isPending && up.variables?.t.key === t.key} onClick={() => { setTarget(t); setTimeout(() => input.current?.click(), 0) }}>
                      <Upload className="size-4" />Upload
                    </Button>
                  )}
                </div>
                {docs.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
                    {docs.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2">
                        <a href={apiUrl(`/files/${d.file}`, undefined, true)} target="_blank" rel="noopener" className="truncate text-brand-700 hover:underline dark:text-brand-300">{d.name}</a>
                        <span className="flex shrink-0 items-center gap-2 text-ink-3">{dateTime(d.uploaded_at)}<StatusBadge status={d.status} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          {q.data.documents.some((d) => !q.data.types.some((t) => t.key === d.type)) && (
            <p className="text-xs text-ink-3">Other documents on this stay: {q.data.documents.filter((d) => !q.data.types.some((t) => t.key === d.type)).map((d) => d.name).join(', ')}</p>
          )}
          <p className="pt-1 text-xs text-ink-3">Document types, their accepted formats and size limits are managed in Settings → IP billing (Documents &amp; printing). <Badge tone="gray">Stored in the patient's documents</Badge></p>
        </div>
      )}
    </Modal>
  )
}
