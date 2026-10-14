/* Vlack HRMS — downtime mode.
 * Network-first for everything; when the network or the API is down, the app shell and the
 * most recent read-only API responses are served from cache so care can continue (read-only).
 * Writes are never cached or replayed. Caches are cleared on sign-out and expire after 12 h.
 */
const SHELL = 'vlack-shell-v1'
const DATA = 'vlack-data-v1'
const MAX_AGE_MS = 12 * 60 * 60 * 1000
const NEVER = ['/api/realtime', '/api/auth', '/api/public/realtime', '/api/files', '/api/portal', '/api/public/portal']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/favicon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (e) => {
  if (e.data === 'clear') e.waitUntil(caches.delete(DATA))
})

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res.ok) {
      const copy = res.clone()
      const headers = new Headers(copy.headers)
      headers.set('x-vlack-cached-at', String(Date.now()))
      const body = await copy.blob()
      cache.put(req, new Response(body, { status: copy.status, statusText: copy.statusText, headers }))
    }
    return res
  } catch (err) {
    const hit = await cache.match(req)
    if (hit) {
      const at = Number(hit.headers.get('x-vlack-cached-at') || 0)
      if (!at || Date.now() - at < MAX_AGE_MS) {
        const headers = new Headers(hit.headers)
        headers.set('x-vlack-offline', '1')
        return new Response(await hit.blob(), { status: hit.status, headers })
      }
    }
    if (req.mode === 'navigate') return (await caches.open(SHELL)).match('/')
    throw err
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (NEVER.some((p) => url.pathname.startsWith(p))) return
  if (url.pathname.startsWith('/api/')) {
    // Only cache responses for authenticated GETs; the Authorization header is part of the request.
    e.respondWith(networkFirst(req, DATA))
    return
  }
  e.respondWith(networkFirst(req, SHELL))
})
