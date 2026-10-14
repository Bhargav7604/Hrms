import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, FileSignature } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { FieldInput } from '@/components/fields'
import { Badge, Button, Empty, ErrorBox, FieldWrap, Input, Select, Spinner, StatusBadge } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { date, dateTime } from '@/lib/format'
import type { FieldDef } from '@/lib/types'
import { Section } from './Home'
import { papi, usePortal } from './lib'

interface Consent {
  id: string; code: string; consent_type?: string | null; procedure?: string | null; planned_date?: string | null; status: string
  doctor?: string | null; text: string; language: string; signed_at?: string | null; signer_name?: string | null
  signer_relationship?: string | null; can_sign: boolean
}

const SIGNATURE: FieldDef = { key: 'signature', label: 'Signature', type: 'signature' }
const LANGUAGES = ['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali']

export function Consents() {
  const { pid, profile, me } = usePortal()
  const qc = useQueryClient()
  const [language, setLanguage] = useState(me.account.preferred_language || 'English')
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['portal', pid, 'consents', language], queryFn: () => papi<Consent[]>('/consents', { query: { pid, language } }) })
  const current = q.data?.find((c) => c.id === open) ?? null

  if (current) {
    return <SignConsent c={current} language={language} setLanguage={setLanguage} onBack={() => setOpen(null)}
      onSigned={() => { setOpen(null); qc.invalidateQueries({ queryKey: ['portal', pid] }) }} />
  }
  const pending = q.data?.filter((c) => c.status === 'Pending') ?? []
  const signed = q.data?.filter((c) => c.status !== 'Pending') ?? []
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">Consent forms</h1>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && q.data.length === 0 && <div className="rounded-2xl border border-line bg-surface"><Empty icon="FileSignature" title="No consent forms">Forms your doctor asks you to sign appear here.</Empty></div>}
      {pending.length > 0 && (
        <Section title="Waiting for signature">
          <ul className="divide-y divide-line">
            {pending.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                <FileSignature className="size-5 shrink-0 text-amber-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{c.procedure || c.consent_type}</span>
                  <span className="block truncate text-xs text-ink-3">{[c.consent_type, c.doctor, c.planned_date ? `planned ${date(c.planned_date)}` : null].filter(Boolean).join(' · ')}</span>
                </span>
                <Button size="sm" variant="primary" onClick={() => setOpen(c.id)}>{c.can_sign ? 'Read & sign' : 'Read'}</Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {signed.length > 0 && (
        <Section title="Signed">
          <ul className="divide-y divide-line">
            {signed.map((c) => (
              <li key={c.id}>
                <button onClick={() => setOpen(c.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{c.procedure || c.consent_type}</span>
                    <span className="block truncate text-xs text-ink-3">Signed {dateTime(c.signed_at)} by {c.signer_name} ({c.signer_relationship})</span>
                  </span>
                  <StatusBadge status={c.status} />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {!profile.can_sign && pending.length > 0 && <p className="text-xs text-ink-3">Only the patient or an authorised representative registered with the hospital can sign these forms.</p>}
    </div>
  )
}

function SignConsent({ c, language, setLanguage, onBack, onSigned }: {
  c: Consent; language: string; setLanguage: (l: string) => void; onBack: () => void; onSigned: () => void
}) {
  const { pid, profile } = usePortal()
  const [agree, setAgree] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [name, setName] = useState(profile.self ? profile.name : '')
  const sign = useMutation({
    mutationFn: () => papi(`/consents/${c.id}/sign`, { method: 'POST', query: { pid }, body: { signature, agree, signer_name: name || undefined } }),
    onSuccess: () => { toast.success('Consent signed. A copy is kept in your hospital record.'); onSigned() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const canSign = c.status === 'Pending' && c.can_sign
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="rounded-full p-1.5 text-ink-2 hover:bg-surface-2" aria-label="Back"><ChevronLeft className="size-5" /></button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold text-ink">{c.procedure || c.consent_type}</h1>
        <StatusBadge status={c.status} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        {c.consent_type && <Badge tone="cyan">{c.consent_type}</Badge>}
        {c.doctor && <span>Explained by {c.doctor}</span>}
        <span className="ml-auto inline-flex items-center gap-2">
          <label htmlFor="cn-lang" className="text-xs">Language</label>
          <Select id="cn-lang" className="h-8 w-32" value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</Select>
        </span>
      </div>
      {c.language !== language && <p className="text-xs text-amber-700 dark:text-amber-300">This form is not available in {language}; showing {c.language}. Ask the nurse or doctor to explain it in your language before signing.</p>}
      <article className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-surface p-4 text-sm leading-relaxed text-ink scroll-thin" tabIndex={0} aria-label="Consent text">
        {c.text || 'The consent text is not available. Please ask the hospital for a printed copy.'}
      </article>
      {canSign ? (
        <form className="space-y-3 rounded-2xl border border-line bg-surface p-4" onSubmit={(e) => { e.preventDefault(); sign.mutate() }}>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-brand-700" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I have read (or had read to me) and understood this form. My questions were answered, and I give my consent{profile.self ? '' : ` on behalf of ${profile.name}`}. I know I can withdraw it at any time.</span>
          </label>
          <FieldWrap label="Name of person signing" required>
            <Input className="h-11" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </FieldWrap>
          <FieldWrap label="Sign below" required>
            <FieldInput field={SIGNATURE} value={signature} onChange={(v) => setSignature((v as string | null) ?? null)} />
          </FieldWrap>
          <Button type="submit" variant="primary" className="h-11 w-full text-base" disabled={!agree || !signature || !name.trim()} loading={sign.isPending}>Sign consent</Button>
        </form>
      ) : c.status === 'Pending' ? (
        <p className="rounded-xl bg-surface-2 p-3 text-sm text-ink-2">You can read this form, but only the patient or an authorised representative can sign it.</p>
      ) : (
        <p className="text-sm text-ink-2">Signed {dateTime(c.signed_at)} by {c.signer_name} ({c.signer_relationship}).</p>
      )}
    </div>
  )
}
