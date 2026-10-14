import * as Lucide from 'lucide-react'
import type { ComponentType } from 'react'

type IconCmp = ComponentType<Lucide.LucideProps>
const named = Lucide as unknown as Record<string, IconCmp | undefined>

/**
 * Render a lucide icon by its PascalCase name (module definitions store icon names).
 * Canonical names come from the `icons` map; legacy aliases (e.g. "Home", "AlertTriangle")
 * resolve through the package's named exports.
 */
export function Icon({ name, ...props }: { name?: string } & Lucide.LucideProps) {
  const Cmp = (name && (Lucide.icons[name as keyof typeof Lucide.icons] ?? named[`${name}Icon`] ?? named[name])) || Lucide.icons.Box
  return <Cmp aria-hidden {...props} />
}
