import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { apiUrl, getToken } from './api'

interface ChangeEvent { fqn: string; module: string; entity: string; id: string; action: string; status?: string; patient_id?: string }

/**
 * One SSE connection per tab (Redis pub/sub on the server). Every committed change
 * invalidates the matching queries so lists, boards and dashboards stay live.
 */
export function useRealtime(enabled: boolean, role?: string) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled || !getToken()) return
    const pendingModules = new Set<string>()
    const pendingPatients = new Set<string>()
    let timer: number | undefined

    const flush = () => {
      timer = undefined
      for (const m of pendingModules) {
        qc.invalidateQueries({ queryKey: ['m', m] })
        qc.invalidateQueries({ queryKey: ['stats', m] })
        qc.invalidateQueries({ queryKey: ['x', m] })
      }
      for (const p of pendingPatients) qc.invalidateQueries({ queryKey: ['patient', p] })
      if (pendingModules.size) qc.invalidateQueries({ queryKey: ['dash'] })
      pendingModules.clear()
      pendingPatients.clear()
    }
    const schedule = () => { if (timer === undefined) timer = window.setTimeout(flush, 400) }

    const es = new EventSource(apiUrl('/realtime', { channels: 'changes,alerts,approvals' }, true))
    es.addEventListener('changes', (ev) => {
      try {
        const c = JSON.parse((ev as MessageEvent).data) as ChangeEvent
        pendingModules.add(c.module)
        if (c.patient_id) pendingPatients.add(c.patient_id)
        schedule()
      } catch { /* ignore malformed */ }
    })
    es.addEventListener('alerts', (ev) => {
      try {
        const a = JSON.parse((ev as MessageEvent).data)
        if (Array.isArray(a.roles) && a.roles.length && !(role && (a.roles.includes(role) || role === 'admin'))) return
        if (a.type === 'critical_result') toast.error(`Critical result: ${a.patient} — ${a.test}`, { duration: 15000 })
        else if (a.type === 'code_blue') toast.error(`CODE BLUE — ${a.location}`, { duration: 30000 })
        else if (a.message) toast(a.message)
      } catch { /* ignore */ }
    })
    es.addEventListener('approvals', () => qc.invalidateQueries({ queryKey: ['approvals'] }))
    // the signed-in user's private channel: internal messages and task updates
    es.addEventListener('me', (ev) => {
      try {
        const m = JSON.parse((ev as MessageEvent).data)
        qc.invalidateQueries({ queryKey: ['messages'] })
        if (m.type === 'message') {
          const text = `${m.from}: ${m.subject}`
          const action = { label: 'Open', onClick: () => { window.location.assign(`/messages?m=${m.id}`) } }
          if (m.priority === 'URGENT' || m.kind === 'ALERT') toast.error(text, { duration: 20000, action, description: m.priority === 'URGENT' ? 'Urgent message' : 'Alert' })
          else if (m.priority === 'HIGH' || m.is_task) toast.warning(text, { duration: 10000, action, description: m.is_task ? 'New task for you' : 'High priority' })
          else toast(text, { action })
        } else if (m.type === 'task' && m.action === 'close') {
          toast.success(`${m.by} closed the task “${m.subject}”`)
        }
      } catch { /* ignore */ }
    })
    return () => { es.close(); if (timer) window.clearTimeout(timer) }
  }, [enabled, qc, role])
}
