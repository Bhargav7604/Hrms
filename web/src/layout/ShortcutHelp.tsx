import { Modal } from '@/components/ui'
import { setChrome, useChrome } from '@/lib/chrome'
import { formatKeys, isMac, useShortcutGroups } from '@/lib/shortcuts'

const GLOBAL = [
  { keys: 'mod+k', label: 'Search pages, patients and actions' },
  { keys: 'ctrl+g', label: 'App Launcher — every page you can open' },
  { keys: '/', label: 'Focus the search box of the list on screen' },
  { keys: 'shift+f', label: 'Focus mode — hide the menus (Esc to exit)' },
  { keys: '?', label: 'This help' },
  { keys: 'esc', label: 'Close a dialog, drawer or menu' },
]

function Keys({ keys }: { keys: string }) {
  const parts = keys.toLowerCase().startsWith('ctrl+') ? ['Ctrl', ...formatKeys(keys.slice(5))] : formatKeys(keys)
  return (
    <span className="flex shrink-0 items-center gap-1">
      {parts.map((k, i) => <kbd key={i} className="min-w-6 rounded border border-line-2 bg-surface-2 px-1.5 py-0.5 text-center font-mono text-[11px] text-ink-2">{k}</kbd>)}
    </span>
  )
}

/** `?` overlay: global shortcuts plus whatever the current page registered with useShortcuts(). */
export function ShortcutHelp() {
  const { help } = useChrome()
  const groups = useShortcutGroups()
  if (!help) return null
  return (
    <Modal open onClose={() => setChrome({ help: false })} title="Keyboard shortcuts" size="lg">
      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Everywhere</h3>
          <ul className="space-y-1.5">
            {GLOBAL.map((s) => <li key={s.keys} className="flex items-center justify-between gap-3 text-sm text-ink"><span>{s.label}</span><Keys keys={s.keys} /></li>)}
          </ul>
        </section>
        {groups.map((g) => (
          <section key={g.id}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{g.title}</h3>
            <ul className="space-y-1.5">
              {g.items.map((s) => <li key={s.keys + s.label} className="flex items-center justify-between gap-3 text-sm text-ink"><span>{s.label}</span><Keys keys={s.keys} /></li>)}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-5 text-xs text-ink-3">{isMac ? '⌘ = Command.' : 'Ctrl = Control.'} Shortcuts do not fire while you are typing in a field, except where noted.</p>
    </Modal>
  )
}
