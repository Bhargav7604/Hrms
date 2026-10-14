import type { ComponentType } from 'react'
import type { RouteNav } from './pages'

/**
 * Feature routes (src/routes/*.tsx). Each file exports `path`, optional `shell`/`nav`, and a default
 * (lazy) component. Files are loaded independently before the router is built, so one broken or
 * unfinished route only removes itself — it can never blank the whole app.
 */
export interface RouteModule {
  path: string
  shell?: boolean
  /** false = public screen (TV boards, kiosks): no sign-in, no app shell */
  auth?: boolean
  nav?: RouteNav
  default: ComponentType
}

const loaders = import.meta.glob<RouteModule>('../routes/*.tsx')

export const featureRoutes: { file: string; mod: RouteModule }[] = []

export async function loadFeatureRoutes(): Promise<void> {
  const entries = Object.entries(loaders)
  const results = await Promise.allSettled(entries.map(([, load]) => load()))
  results.forEach((r, i) => {
    const file = entries[i][0]
    if (r.status === 'fulfilled' && r.value?.path && r.value.default) featureRoutes.push({ file, mod: r.value })
    else console.error(`[routes] skipped ${file}:`, r.status === 'rejected' ? r.reason : 'missing path or default export')
  })
}
