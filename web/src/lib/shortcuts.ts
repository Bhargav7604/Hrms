import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Keyboard shortcuts. Pages register theirs with `useShortcuts` and they appear in the `?` help
 * overlay automatically:
 *
 *   useShortcuts('Bed board', [
 *     { keys: 'n', label: 'New admission', run: () => setOpen(true) },
 *     { keys: 'mod+s', label: 'Save', run: save, allowInInput: true },
 *   ])
 *
 * `keys`: a single key ("n", "/", "?", "Escape", "F9"), optionally with modifiers joined by "+"
 * ("mod" = ⌘ on macOS, Ctrl elsewhere; "shift", "alt").
 */
export interface Shortcut {
  keys: string
  label: string
  run?: (e: KeyboardEvent) => void
  /** fire even while typing in an input / textarea */
  allowInInput?: boolean
}

interface Group { id: number; title: string; items: Shortcut[] }

let groups: Group[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

export function registerShortcuts(title: string, items: Shortcut[]): () => void {
  const g = { id: ++seq, title, items }
  groups = [...groups, g]
  emit()
  return () => { groups = groups.filter((x) => x.id !== g.id); emit() }
}

export function useShortcutGroups(): Group[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => groups)
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export function matches(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split('+')
  const key = parts.pop()!
  const want = { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') }
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (want.mod !== mod || want.alt !== e.altKey) return false
  const k = e.key.toLowerCase()
  // "?" and "/" arrive with shift on most layouts; only enforce shift when asked for letters
  if (want.shift && !e.shiftKey) return false
  if (!want.shift && e.shiftKey && /^[a-z0-9]$/.test(k)) return false
  return k === key || (key === 'esc' && k === 'escape')
}

export function formatKeys(keys: string): string[] {
  return keys.split('+').map((p) => {
    const k = p.toLowerCase()
    if (k === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (k === 'shift') return '⇧'
    if (k === 'alt') return isMac ? '⌥' : 'Alt'
    if (k === 'escape' || k === 'esc') return 'Esc'
    if (k === 'enter') return '↵'
    if (k === 'arrowup') return '↑'
    if (k === 'arrowdown') return '↓'
    return p.length === 1 ? p.toUpperCase() : p
  })
}

/** Register page shortcuts (shown in the `?` overlay) and handle them while the page is mounted. */
export function useShortcuts(title: string, items: Shortcut[], enabled = true) {
  const ref = useRef(items)
  ref.current = items
  const sig = items.map((i) => `${i.keys}:${i.label}`).join('|')
  useEffect(() => {
    if (!enabled) return
    const off = registerShortcuts(title, ref.current)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      for (const s of ref.current) {
        if (!s.run || !matches(e, s.keys)) continue
        if (isTyping(e) && !s.allowInInput) continue
        e.preventDefault()
        s.run(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { off(); window.removeEventListener('keydown', onKey) }
  }, [title, sig, enabled])
}
