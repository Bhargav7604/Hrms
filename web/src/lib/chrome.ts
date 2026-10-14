import { useSyncExternalStore } from 'react'

/**
 * App-chrome state shared by the shell and page headers without a provider:
 * focus (expand) mode hides the sidebar and top bar for work screens; the `?` overlay lists shortcuts;
 * the launcher / palette / compose dialogs can be opened from anywhere.
 */
interface ChromeState {
  focus: boolean
  help: boolean
  launcher: boolean
  palette: boolean
  compose: boolean
  ticket: boolean
}

let state: ChromeState = { focus: false, help: false, launcher: false, palette: false, compose: false, ticket: false }
const listeners = new Set<() => void>()

export function setChrome(patch: Partial<ChromeState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function useChrome(): ChromeState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state)
}

export const toggleFocus = () => setChrome({ focus: !state.focus })
export const openShortcutHelp = () => setChrome({ help: true })
export const openLauncher = () => setChrome({ launcher: true, palette: false })
export const openPalette = () => setChrome({ palette: true, launcher: false })
export const openCompose = () => setChrome({ compose: true })
export const getChrome = () => state
