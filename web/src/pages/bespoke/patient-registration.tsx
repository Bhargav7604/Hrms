import RegisterPatient from '@/features/registration/RegisterPatient'
import type { BespokeProps } from './index'

/** Register Patient (v2) inside the Registration module — the same screen as /registration/new. */
export default function PatientRegistration(_: BespokeProps) {
  return <RegisterPatient embedded />
}
