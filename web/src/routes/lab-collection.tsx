import { lazy } from 'react'

export const path = '/lab/collection'
export const nav = { label: 'Sample collection', icon: 'Syringe', group: 'Laboratory (LIS)', roles: ['lab', 'nurse'], keywords: 'lab phlebotomy barcode labels ward round tubes' }
export default lazy(() => import('@/features/lab/Collection'))
