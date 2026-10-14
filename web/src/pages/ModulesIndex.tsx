import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Input, PageHeader } from '@/components/ui'
import { useRegistry } from '@/lib/auth'
import { Icon } from '@/lib/icons'

export default function ModulesIndex() {
  const { meta, modules } = useRegistry()
  const [q, setQ] = useState('')
  const f = q.trim().toLowerCase()
  const shown = modules.filter((m) => !f || `${m.no} ${m.name} ${m.summary} ${m.features.join(' ')}`.toLowerCase().includes(f))
  return (
    <div>
      <PageHeader icon="LayoutGrid" title="All modules"
        subtitle={`${modules.length} modules across ${meta?.suites.length ?? 0} suites, sharing one patient, order, result, billing and audit engine.`}
        actions={<div className="relative w-72"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" /><Input className="pl-8" placeholder="Search modules and features" value={q} onChange={(e) => setQ(e.target.value)} /></div>} />
      <div className="space-y-8">
        {meta?.suites.map((s) => {
          const mods = shown.filter((m) => m.suite === s.id)
          if (!mods.length) return null
          return (
            <section key={s.id}>
              <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-ink">
                {s.name} <span className="text-xs font-normal text-ink-3">{mods.length} modules</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {mods.map((m) => (
                  <Link key={m.id} to={`/m/${m.id}`} className="group flex gap-3 rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-brand-600/40">
                    <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 group-hover:bg-brand-700 group-hover:text-white dark:bg-brand-500/10 dark:text-brand-300">
                      <Icon name={m.icon} className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold tabular-nums text-ink-3">{String(m.no).padStart(2, '0')}</span>
                        <span className="truncate text-sm font-semibold text-ink">{m.name}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{m.summary}</p>
                      <p className="mt-1.5 text-[11px] text-ink-3">{m.entities.length} record types{m.pages.length ? ` · ${m.pages.length} workspace${m.pages.length > 1 ? 's' : ''}` : ''}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
