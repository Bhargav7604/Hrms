import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { Button, FieldWrap, Input } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'

const DEMO = [
  ['admin', 'System admin'], ['ceo', 'CEO'], ['cfo', 'CFO'], ['dr.rao', 'Doctor'], ['dr.lakshmi', 'Doctor 2'],
  ['nurse.priya', 'Nurse'], ['frontdesk', 'Front office'], ['billing', 'Billing'], ['pharmacy', 'Pharmacist'],
  ['lab', 'Laboratory'], ['radiology', 'Radiology'], ['hr', 'HR & Payroll'], ['stores', 'Stores'],
  ['quality', 'Quality'], ['support', 'Support services'], ['marketing', 'Marketing'], ['employee', 'Employee (ESS)'],
]
// Development only (web/.env.development.local): demo chips sign in with one click.
const DEMO_PASSWORD = import.meta.env.DEV ? (import.meta.env.VITE_DEMO_PASSWORD as string | undefined) : undefined

export default function Login() {
  const { token, login } = useAuth()
  const nav = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (token) return <Navigate to="/" replace />
  const submit = async (u = username, p = password) => {
    setBusy(true); setErr(null)
    try { await login(u, p); nav('/') } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-brand-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" className="size-10" alt="" />
          <span className="text-lg font-semibold">Vlack HRMS</span>
        </div>
        <div className="max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">One patient. One record.<br />Every department.</h1>
          <p className="mt-4 text-cyan-100/80">80 modules from front desk to boardroom — registration, clinical care, diagnostics, operations, finance, HR & payroll — on one identity, one order-to-result flow and one audit trail.</p>
          <div className="mt-8 grid grid-cols-3 gap-4 text-sm">
            {[['80', 'modules'], ['6', 'suites'], ['100%', 'audited']].map(([a, b]) => (
              <div key={b} className="rounded-xl bg-white/5 p-4 ring-1 ring-white/10"><div className="text-2xl font-semibold">{a}</div><div className="text-cyan-100/70">{b}</div></div>
            ))}
          </div>
        </div>
        <p className="text-xs text-cyan-100/50">NABH · JCI · ABDM ready · DPDP Act 2023 aligned</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-ink-2">Use your hospital staff account.</p>
          <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
            <FieldWrap label="Username"><Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></FieldWrap>
            <FieldWrap label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></FieldWrap>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <Button type="submit" variant="primary" className="w-full" loading={busy}>Sign in</Button>
          </form>
          {import.meta.env.DEV && (
            <div className="mt-8">
              <p className="mb-2 text-xs font-medium text-ink-3">Demo accounts — {DEMO_PASSWORD ? 'click to sign in' : 'password in backend/.env.example'}</p>
              <div className="flex flex-wrap gap-1.5">
                {DEMO.map(([u, l]) => (
                  <button key={u} type="button" title={u} disabled={busy}
                    onClick={() => { setUsername(u); if (DEMO_PASSWORD) { setPassword(DEMO_PASSWORD); submit(u, DEMO_PASSWORD) } }}
                    className="rounded-md border border-line-2 px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">{l}</button>
                ))}
              </div>
            </div>
          )}
          <p className="mt-8 text-center text-xs text-ink-3">Patients: use the <a className="text-brand-700 hover:underline" href="/portal">patient portal</a></p>
        </div>
      </div>
    </div>
  )
}
