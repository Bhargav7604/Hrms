import { lazy } from 'react'

export const path = '/assets/dashboard'
export const nav = {
  label: 'Asset dashboard', icon: 'LayoutDashboard', module: 'assets', page: 'asset-dashboard',
  keywords: 'assets biomedical equipment pm calibration amc',
}
export default lazy(() => import('@/features/assets/AssetDashboardPage'))
