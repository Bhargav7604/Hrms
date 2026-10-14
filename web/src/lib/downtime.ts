import { useEffect, useState } from 'react'

/** Registers the downtime-mode service worker (production builds only). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* downtime mode unavailable */ })
  })
}

/** Drop cached API data (called on sign-out so no patient data stays on a shared device). */
export function clearOfflineData() {
  navigator.serviceWorker?.controller?.postMessage('clear')
}

/** True while the browser has no network or the API is unreachable. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    let timer: number | undefined
    const probe = async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        setOnline(r.ok && !r.headers.get('x-vlack-offline'))
      } catch {
        setOnline(false)
      }
      timer = window.setTimeout(probe, 30_000)
    }
    probe()
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
      if (timer) window.clearTimeout(timer)
    }
  }, [])
  return online
}
