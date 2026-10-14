import { lazy } from 'react'

export const path = '/op/nurse-worklist'
export const nav = {
  label: 'Nurse Worklist', icon: 'ClipboardList', module: 'opd', page: 'nurse-worklist',
  keywords: 'op opd vitals nursing assessment check in triage bp weight news2', description: 'Capture OP vitals and the nursing assessment',
}
export default lazy(() => import('@/features/opd/NurseWorklist'))
