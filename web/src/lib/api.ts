const TOKEN_KEY = 'vlack.token'
const PORTAL_TOKEN_KEY = 'vlack.portal.token'
const BRANCH_KEY = 'vlack.branch'

export class ApiError extends Error {
  status: number
  details?: { fields?: Record<string, string> } & Record<string, unknown>
  code?: string
  constructor(status: number, message: string, details?: ApiError['details'], code?: string) {
    super(message)
    this.status = status
    this.details = details
    this.code = code
  }
  get fieldErrors(): Record<string, string> {
    return this.details?.fields ?? {}
  }
}

const read = (k: string) => {
  try { return localStorage.getItem(k) } catch { return null }
}
const write = (k: string, v: string | null) => {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* storage unavailable */ }
}

export const getToken = () => read(TOKEN_KEY)
export const setToken = (t: string | null) => write(TOKEN_KEY, t)
export const getPortalToken = () => read(PORTAL_TOKEN_KEY)
export const setPortalToken = (t: string | null) => write(PORTAL_TOKEN_KEY, t)
/** Active branch (multi-site): sent as `X-Branch` on every request, `?branch=` on downloads/SSE. */
export const getBranch = () => read(BRANCH_KEY)
export const setBranch = (b: string | null) => write(BRANCH_KEY, b)

// Break-glass: restricted records require a reason. The app registers a prompt handler;
// the reason is cached per session so the user is not asked on every request.
type BreakGlassHandler = (message: string) => Promise<string | null>
let breakGlassHandler: BreakGlassHandler | null = null
let breakGlassReason: string | null = null
export const setBreakGlassHandler = (h: BreakGlassHandler) => { breakGlassHandler = h }

type Query = Record<string, string | number | boolean | null | undefined>

interface Opts {
  method?: string
  body?: unknown
  query?: Query
  portal?: boolean
  signal?: AbortSignal
}

export function apiUrl(path: string, query?: Query, withToken = false): string {
  const url = new URL(`/api${path}`, window.location.origin)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  if (withToken) {
    const t = getToken()
    if (t) url.searchParams.set('token', t)
    const b = getBranch()
    if (b && !url.searchParams.has('branch')) url.searchParams.set('branch', b)
  }
  return url.pathname + url.search
}

export async function api<T = unknown>(path: string, opts: Opts = {}, retried = false): Promise<T> {
  const { method = 'GET', body, query, portal, signal } = opts
  const token = portal ? getPortalToken() : getToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (breakGlassReason && !portal) headers['X-Break-Glass'] = breakGlassReason
  const branch = portal ? null : getBranch()
  if (branch) headers['X-Branch'] = branch
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(apiUrl(path, query), { method, headers, body: payload, signal })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ApiError(0, method === 'GET'
      ? 'The server is unreachable and this page is not available offline.'
      : 'Downtime mode — the server is unreachable, so changes cannot be saved. Record on paper and enter when back online.')
  }
  const ct = res.headers.get('content-type') ?? ''
  const data = ct.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const err = new ApiError(res.status, (data && data.message) || res.statusText, data?.details, data?.details?.code ?? data?.code)
    if (res.status === 403 && err.code === 'BRANCH_FORBIDDEN' && !retried) {
      setBranch(null) // stale branch from another account: fall back to the user's home branch
      window.dispatchEvent(new Event('vlack:branch'))
      return api<T>(path, opts, true)
    }
    if (res.status === 401 && token) {
      if (portal) setPortalToken(null)
      else {
        setToken(null)
        window.dispatchEvent(new Event('vlack:logout'))
      }
    }
    if (res.status === 403 && err.code === 'BREAK_GLASS_REQUIRED' && breakGlassHandler && !retried) {
      const reason = await breakGlassHandler(err.message)
      if (reason) {
        breakGlassReason = reason
        return api<T>(path, opts, true)
      }
    }
    throw err
  }
  return data as T
}

export const get = <T,>(path: string, query?: Query) => api<T>(path, { query })
export const post = <T,>(path: string, body?: unknown, query?: Query) => api<T>(path, { method: 'POST', body, query })
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body })
export const del = <T,>(path: string, query?: Query) => api<T>(path, { method: 'DELETE', query })

export async function uploadFile(file: File, patientId?: string): Promise<{ id: string; name: string; mime: string; size: number }> {
  const fd = new FormData()
  fd.append('file', file)
  if (patientId) fd.append('patient_id', patientId)
  return api('/files', { method: 'POST', body: fd })
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const fields = Object.values(e.fieldErrors)
    return fields.length ? `${e.message}: ${fields.slice(0, 3).join('; ')}` : e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong'
}
