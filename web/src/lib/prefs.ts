import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { api } from './api'
import { useAuth } from './auth'

/**
 * Per-user preferences stored on the server (column layouts, favourites, density, rows per page…),
 * so they follow the user across devices. One request loads all of them.
 *
 *   const [cols, setCols] = usePref<string[] | null>(`cols:${entity.fqn}`, null)
 */
type Prefs = Record<string, unknown>

export function usePrefs() {
  const { token } = useAuth()
  return useQuery({
    queryKey: ['prefs'],
    queryFn: () => api<{ prefs: Prefs }>('/prefs').then((r) => r.prefs),
    enabled: !!token,
    staleTime: Infinity,
  })
}

export function usePref<T>(key: string, fallback: T): [T, (v: T | null) => void, boolean] {
  const qc = useQueryClient()
  const q = usePrefs()
  const value = (q.data && key in q.data ? (q.data[key] as T) : fallback)
  const set = useCallback((v: T | null) => {
    qc.setQueryData<Prefs>(['prefs'], (old) => {
      const next = { ...(old ?? {}) }
      if (v === null) delete next[key]
      else next[key] = v
      return next
    })
    api(`/prefs/${encodeURIComponent(key)}`, { method: 'PUT', body: { value: v } }).catch(() => { /* kept locally for this session */ })
  }, [qc, key])
  return [value, set, q.isSuccess]
}
