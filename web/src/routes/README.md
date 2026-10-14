Feature routes. Each `<name>.tsx` here exports:

```tsx
import { lazy } from 'react'
export const path = '/ip/admissions/:id'   // absolute path
export const shell = true                   // optional; false = full-screen without the app shell
export default lazy(() => import('@/features/ipd/AdmissionChart'))   // keep route files thin
```

They are picked up automatically by `src/main.tsx` (no router edits needed). Put the screen code in
`src/features/<area>/…` so it is code-split.

Optional — list the page in the App Launcher (Ctrl+G), the ⌘K palette and the Support module index:

```tsx
export const nav = {
  label: 'On Bed', icon: 'BedDouble',                 // tile label + lucide icon
  module: 'ipd', page: 'bed-board',                   // visible only to roles that can open this module page
  // or: roles: ['nurse', 'doctor']                   // (no module/page/roles = every signed-in user)
  keywords: 'census inpatients money', description: 'Live bed census with money',
}
```

Routes with path parameters (`:id`) are not listed. Create the feature file in the same change as the
route file — a route that imports a missing file breaks the dev server for everyone.
Page chrome for feature screens: `PageHeader` gives the focus (expand) toggle, the `?` shortcut help and an
optional `guide`; register page shortcuts with `useShortcuts('Title', [...])` from `@/lib/shortcuts`.
