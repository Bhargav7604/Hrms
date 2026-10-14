import { Navigate } from 'react-router'

// The consultation-format editor lives in OPD (W5); keep the platform link working.
export const path = '/settings/consultation-format'
export default function ConsultationFormatRedirect() {
  return <Navigate to="/op/consultation-format" replace />
}
