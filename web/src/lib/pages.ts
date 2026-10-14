import { useMemo } from 'react'
import { useRegistry } from './auth'
import { featureRoutes } from './routes'
import type { ModuleDef } from './types'

/**
 * Catalogue of every page the signed-in user can open — used by the App Launcher (Ctrl+G), the ⌘K
 * command palette and the Support module index. Built from the permission-filtered registry
 * (module workspaces + record lists), the platform pages and feature routes that export `nav`:
 *
 *   // src/routes/ip-admission-chart.tsx
 *   export const nav = { label: 'IP chart', icon: 'FileHeart', module: 'ipd', page: 'bed-board', keywords: 'admission' }
 *
 * A feature route is listed when its `module`/`page` is visible to the role (or its `roles` include the
 * role, or it names neither). Routes with path parameters are not listed.
 */
export interface PageItem {
  id: string
  label: string
  path: string
  icon: string
  /** section: module name, "Platform" or "Administration" */
  group: string
  groupId: string
  /** chip: suite id, "platform" or "admin" */
  suite: string
  kind: 'workspace' | 'records' | 'platform' | 'admin' | 'feature'
  keywords: string
  description?: string
  level?: 'view' | 'edit'
}

export interface RouteNav {
  label: string
  icon?: string
  module?: string
  page?: string
  roles?: string[]
  group?: string
  keywords?: string
  description?: string
}


export const PLATFORM_SUITE = { id: 'platform', name: 'Workspace & help', short: 'Platform' }
export const ADMIN_SUITE = { id: 'admin', name: 'Administration', short: 'Admin' }

function platformPages(role: string, isDoctor: boolean): PageItem[] {
  const p = (id: string, label: string, path: string, icon: string, keywords: string, description: string, admin = false): PageItem => ({
    id, label, path, icon, keywords, description, group: admin ? 'Administration' : 'Workspace', groupId: admin ? 'admin' : 'platform',
    suite: admin ? 'admin' : 'platform', kind: admin ? 'admin' : 'platform',
  })
  const out = [
    p('home', 'Dashboard', '/', 'LayoutDashboard', 'home command centre overview', 'Your home dashboard'),
    p('modules', 'All modules', '/modules', 'LayoutGrid', 'index catalogue', 'Every module you can open'),
    p('messages', 'Messages', '/messages', 'MessagesSquare', 'inbox chat tasks internal mail', 'Internal messages and tasks'),
    p('support', 'Support', '/support', 'LifeBuoy', 'help ticket module index guide', 'Module index and support tickets'),
    p('sessions', 'Devices & sessions', '/account/sessions', 'MonitorSmartphone', 'security sign out devices login', 'Where you are signed in'),
  ]
  if (isDoctor || role === 'admin') {
    out.push(p('consult-format', 'My consultation format', '/settings/consultation-format', 'SlidersHorizontal',
      'emr opd layout fields arrange personal', 'Arrange your own consultation screen'))
  }
  if (role === 'admin') {
    out.push(
      p('admin-users', 'Users', '/admin/users', 'UsersRound', 'accounts staff login branches', 'User accounts, roles and branches', true),
      p('admin-roles', 'Roles & permissions', '/admin/roles', 'ShieldCheck', 'rbac access matrix custom role', 'What each role can see and do', true),
      p('admin-config', 'Field configuration', '/admin/config', 'SlidersHorizontal', 'masters form fields required hidden mask config', 'Configure forms per branch, department and doctor', true),
      p('admin-audit', 'Audit trail', '/admin/audit', 'History', 'log security nabh', 'Every create, change, print and break-glass', true),
    )
  }
  return out
}

export function modulePages(m: ModuleDef): PageItem[] {
  const out: PageItem[] = []
  for (const pg of m.pages) {
    if (!m.access.pages.includes(pg.key)) continue
    out.push({
      id: `${m.id}/${pg.key}`, label: pg.label, path: `/m/${m.id}/${pg.key}`, icon: pg.icon ?? m.icon, group: m.name, groupId: m.id,
      suite: m.suite, kind: 'workspace', keywords: `${m.name} ${m.no} ${pg.key}`, description: m.summary,
      level: m.access.page_levels?.[pg.key] === 'view' ? 'view' : 'edit',
    })
  }
  for (const e of m.entities) {
    const a = m.access.entities[e.key]
    if (!a?.read) continue
    out.push({
      id: `${m.id}/${e.key}`, label: e.label, path: `/m/${m.id}/${e.key}`, icon: e.icon ?? m.icon, group: m.name, groupId: m.id,
      suite: m.suite, kind: 'records', keywords: `${m.name} ${e.singular} ${e.prefix} ${e.key}`, description: e.description,
      level: a.write ? 'edit' : 'view',
    })
  }
  return out
}

export function usePages(): PageItem[] {
  const reg = useRegistry()
  return useMemo(() => {
    const me = reg.meta?.user
    if (!me) return []
    const isDoctor = reg.canPage('opd', 'consultation-format')
    const out = platformPages(me.role, isDoctor)
    for (const m of reg.modules) out.push(...modulePages(m))
    for (const { file, mod: r } of featureRoutes) {
      const n = r.nav
      if (!n || !r.path || r.path.includes(':')) continue
      const ok = n.module && n.page ? reg.canPage(n.module, n.page) : n.module ? !!reg.module(n.module) : n.roles ? n.roles.includes(me.role) || me.role === 'admin' : true
      if (!ok) continue
      const mod = n.module ? reg.module(n.module) : undefined
      out.push({
        id: `route:${file}`, label: n.label, path: r.path, icon: n.icon ?? mod?.icon ?? 'AppWindow', group: n.group ?? mod?.name ?? 'Workspace',
        groupId: mod?.id ?? n.group ?? 'platform', suite: mod?.suite ?? 'platform', kind: 'feature',
        keywords: `${n.keywords ?? ''} ${mod?.name ?? ''}`, description: n.description,
      })
    }
    return out
  }, [reg])
}

/** Case-insensitive match on every word of the query against label, group, path and keywords. */
export function matchPage(p: PageItem, q: string): number {
  const query = q.trim().toLowerCase()
  if (!query) return 1
  const label = p.label.toLowerCase()
  const hay = `${label} ${p.group.toLowerCase()} ${p.path.toLowerCase()} ${p.keywords.toLowerCase()}`
  const words = query.split(/\s+/)
  if (!words.every((w) => hay.includes(w))) return 0
  if (label.startsWith(query)) return 4
  if (label.includes(query)) return 3
  if (words.every((w) => label.includes(w))) return 2
  return 1
}
