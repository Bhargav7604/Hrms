/**
 * Home = the Command Centre: a role-aware executive dashboard (headline KPIs vs a comparison period,
 * Overview / Money / Patients / Beds & IP / TAT & Diagnostics / Alerts, live queues, quick actions and
 * the dashboards open to this role). The screen lives in the dashboards feature.
 */
import CommandCentre from '@/features/dashboards/CommandCentre'

export default function Home() {
  return <CommandCentre />
}
