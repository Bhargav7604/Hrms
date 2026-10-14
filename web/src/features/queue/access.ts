import { useMemo } from 'react'
import { useRegistry } from '@/lib/auth'

export type QueuePage = 'queue-monitor' | 'queue-console' | 'queue-display' | 'token-register' | 'token-reports'
export type QueueMaster = 'queue.queues' | 'queue.counters' | 'queue.display_boards'

/**
 * What the signed-in role can see and do in Queue Management. Mirrors the server checks:
 * every queue endpoint needs `queue.tokens` read; calling, issuing and transferring need it at
 * "edit" (the tokens entity is read-only in generic lists, so its `write` flag is always false —
 * the level is what the engine enforces). Workspace pages follow the roles & permissions matrix.
 */
export function useQueueAccess() {
  const reg = useRegistry()
  return useMemo(() => {
    const tokens = reg.level('entity', 'queue.tokens')
    const read = tokens !== 'none'
    const write = tokens === 'edit'
    const page = (p: QueuePage, mode: 'read' | 'edit' = 'read') => reg.canPage('queue', p, mode)
    const master = (fqn: QueueMaster, mode: 'read' | 'write' = 'write') => reg.canEntity(fqn, mode)
    return {
      ready: !!reg.meta,
      role: reg.meta?.user?.role ?? '',
      hospital: reg.meta?.hospital.name ?? '',
      readTokens: read,
      monitor: page('queue-monitor') && read,
      console: page('queue-console') && read,
      /** call / recall / serve / done / hold / transfer at a counter */
      operate: page('queue-console', 'edit') && write,
      /** issue walk-in and kiosk tokens */
      issue: page('queue-console', 'edit') && write,
      display: page('queue-display'),
      boards: page('queue-display') && master('queue.display_boards', 'read'),
      register: page('token-register') && read,
      reports: page('token-reports') && read,
      /** open / close a counter */
      counterState: master('queue.counters'),
      master,
      /** any master the role may edit (Display Boards › Manage masters) */
      anyMaster: master('queue.queues') || master('queue.counters') || master('queue.display_boards'),
    }
  }, [reg])
}

export type QueueAccess = ReturnType<typeof useQueueAccess>
