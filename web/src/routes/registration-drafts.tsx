import { lazy } from 'react'

export const path = '/registration/drafts'
export const nav = { label: 'Draft registrations', icon: 'FilePen', module: 'registration', page: 'patient-registration', keywords: 'saved incomplete registration' }
export default lazy(() => import('@/features/registration/DraftsPage'))
