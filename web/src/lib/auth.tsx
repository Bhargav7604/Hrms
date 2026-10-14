import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { get, getBranch, getToken, post, setBranch, setToken } from './api'
import { clearOfflineData } from './downtime'
import type { Level, Meta, ModuleDef, User } from './types'

interface AuthState {
  token: string | null
  user: User | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [token, setTok] = useState<string | null>(() => getToken())
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    if (!token || user) return
    get<{ user: User }>('/auth/me').then((r) => setUser(r.user)).catch(() => { /* 401 handler signs out */ })
  }, [token, user])

  useEffect(() => {
    const onLogout = () => { setTok(null); setUser(null); qc.clear() }
    const onBranch = () => { qc.invalidateQueries() }
    window.addEventListener('vlack:logout', onLogout)
    window.addEventListener('vlack:branch', onBranch)
    return () => { window.removeEventListener('vlack:logout', onLogout); window.removeEventListener('vlack:branch', onBranch) }
  }, [qc])

  const login = useCallback(async (username: string, password: string) => {
    const res = await post<{ token: string; user: User }>('/auth/login', { username, password })
    setToken(res.token)
    setTok(res.token)
    setUser(res.user)
  }, [])

  const logout = useCallback(async () => {
    try { await post('/auth/logout') } catch { /* token may already be invalid */ }
    setToken(null)
    setTok(null)
    setUser(null)
    qc.clear()
    clearOfflineData()
  }, [qc])

  const value = useMemo(() => ({ token, user, login, logout }), [token, user, login, logout])
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

export function useMeta() {
  const { token } = useAuth()
  return useQuery({
    queryKey: ['meta'],
    queryFn: async () => {
      const m = await get<Meta>('/meta')
      // the server resolves the active branch (a stale or disallowed one falls back to the home branch)
      if (m.branch && m.branch !== getBranch()) setBranch(m.branch)
      return m
    },
    enabled: !!token,
    staleTime: 5 * 60_000,
  })
}

/** Active branch + switcher. Switching refetches everything for the new branch. */
export function useBranch() {
  const { data } = useMeta()
  const qc = useQueryClient()
  const switchBranch = useCallback((code: string) => {
    setBranch(code)
    qc.invalidateQueries()
  }, [qc])
  const branches = data?.branches ?? []
  const current = branches.find((b) => b.code === data?.branch)
  return { branch: data?.branch, current, branches, switchBranch }
}

/** Convenience accessors over the module registry. */
export function useRegistry() {
  const { data } = useMeta()
  return useMemo(() => {
    const modules = data?.modules ?? []
    const byId = new Map(modules.map((m) => [m.id, m]))
    const entity = (fqn: string) => {
      const [mid, key] = fqn.split('.')
      return byId.get(mid)?.entities.find((e) => e.key === key)
    }
    /** Level of a workspace page or record type from the roles & permissions matrix. */
    const pageLevel = (mid: string, page: string): Level => {
      const acc = byId.get(mid)?.access
      if (!acc?.pages.includes(page)) return 'none'
      return acc.page_levels?.[page] ?? 'edit'
    }
    const entityLevel = (fqn: string): Level => {
      const [mid, key] = fqn.split('.')
      const a = byId.get(mid)?.access.entities[key]
      if (!a?.read) return 'none'
      return a.level ?? (a.write ? 'edit' : 'view')
    }
    /** `level('page', 'billing', 'billing-desk')` or `level('entity', 'billing.invoices')` */
    const level = (kind: 'page' | 'entity', a: string, b?: string): Level => (kind === 'page' ? pageLevel(a, b ?? '') : entityLevel(a))
    /** canPage(module, page) — visible; canPage(module, page, 'edit') — may operate it (not view-only) */
    const canPage = (mid: string, page: string, mode: 'read' | 'edit' = 'read') => {
      const lv = pageLevel(mid, page)
      return mode === 'edit' ? lv === 'edit' : lv !== 'none'
    }
    const canEntity = (fqn: string, mode: 'read' | 'write' = 'read') => {
      const [mid, key] = fqn.split('.')
      return !!byId.get(mid)?.access.entities[key]?.[mode]
    }
    const roleLabel = (u?: User | null) => (u ? data?.roles[u.perm_role ?? u.role] ?? data?.roles[u.role] ?? u.role : '')
    return { meta: data, modules, module: (id: string): ModuleDef | undefined => byId.get(id), entity, canPage, canEntity, level, pageLevel, entityLevel, roleLabel }
  }, [data])
}
