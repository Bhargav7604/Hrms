import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ModuleDef } from '@/lib/types'

/**
 * Bespoke module workspaces. A module definition lists `pages: [{ key: 'bed-board', ... }]`;
 * the screen is the default export of `./<key>.tsx` in this folder. Adding a file registers it.
 */
export type BespokeProps = { module: ModuleDef }

const files = import.meta.glob<{ default: ComponentType<BespokeProps> }>('./*.tsx')

export const BESPOKE: Record<string, LazyExoticComponent<ComponentType<BespokeProps>>> = Object.fromEntries(
  Object.entries(files).map(([path, load]) => [path.slice(2, -4), lazy(load)]),
)
