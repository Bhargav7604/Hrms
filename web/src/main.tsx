import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, StrictMode, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { Spinner } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { AuthProvider, useAuth } from '@/lib/auth'
import { registerServiceWorker } from '@/lib/downtime'
import { featureRoutes, loadFeatureRoutes } from '@/lib/routes'
import { AppShell } from '@/layout/AppShell'
import Login from '@/pages/Login'
import ModulePage from '@/pages/ModulePage'
import ModulesIndex from '@/pages/ModulesIndex'
import './index.css'

const Home = lazy(() => import('@/pages/Home'))
const Patient360 = lazy(() => import('@/pages/Patient360'))
const PrintPage = lazy(() => import('@/pages/PrintPage'))
const AdminUsers = lazy(() => import('@/pages/AdminUsers'))
const AdminAudit = lazy(() => import('@/pages/AdminAudit'))
const PortalApp = lazy(() => import('@/portal/PortalApp'))
const QueueTv = lazy(() => import('@/pages/QueueTv'))
const PreRegister = lazy(() => import('@/pages/PreRegister'))

registerServiceWorker()

try {
  if (localStorage.getItem('vlack.theme') === 'dark') document.documentElement.classList.add('dark')
} catch { /* ignore */ }

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
})

function Protected({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  return token ? children : <Navigate to="/login" replace />
}

const S = ({ children }: { children: ReactNode }) => <Suspense fallback={<Spinner />}>{children}</Suspense>

// Feature routes (src/routes/*.tsx) load independently; a broken one is skipped, not fatal.
await loadFeatureRoutes()
const shellRoutes = featureRoutes.filter(({ mod }) => mod.auth !== false && mod.shell !== false)
  .map(({ mod: m }) => ({ path: m.path.replace(/^\//, ''), element: <S><m.default /></S> }))
const bareRoutes = featureRoutes.filter(({ mod }) => mod.auth !== false && mod.shell === false)
  .map(({ mod: m }) => ({ path: m.path, element: <Protected><S><m.default /></S></Protected> }))
const publicRoutes = featureRoutes.filter(({ mod }) => mod.auth === false)
  .map(({ mod: m }) => ({ path: m.path, element: <S><m.default /></S> }))

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/portal/*', element: <S><PortalApp /></S> },
  { path: '/display/queue', element: <S><QueueTv /></S> },
  { path: '/pre-register', element: <S><PreRegister /></S> },
  { path: '/print/:module/:entity/:id', element: <Protected><S><PrintPage /></S></Protected> },
  ...publicRoutes,
  ...bareRoutes,
  {
    path: '/',
    element: <Protected><AppShell /></Protected>,
    children: [
      { index: true, element: <S><Home /></S> },
      { path: 'modules', element: <ModulesIndex /> },
      { path: 'm/:moduleId', element: <ModulePage /> },
      { path: 'm/:moduleId/:tab', element: <ModulePage /> },
      { path: 'patients/:id', element: <S><Patient360 /></S> },
      { path: 'admin/users', element: <S><AdminUsers /></S> },
      { path: 'admin/audit', element: <S><AdminAudit /></S> },
      ...shellRoutes,
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster richColors position="top-right" closeButton />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
