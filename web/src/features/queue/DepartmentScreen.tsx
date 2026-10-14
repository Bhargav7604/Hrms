import { useEffect } from 'react'
import { useParams } from 'react-router'
import type { PublicDepartment } from './types'
import { PublicError, Ticker, tvColumns, TvGrid, TvLineCard, TvMessage, TvScreen, useCallFlash, usePublicScreen, useSound } from './tv'

const NOTE = 'Please wait near the room shown with your token · Emergency, senior citizen and differently-abled patients are served first'

/**
 * Department screen at /queue/department/<department code or id>: every doctor cabin of the
 * department consulting today — doctor, room, session times, now serving and next tokens — plus the
 * department's own queues. No patient names (DPDP).
 */
export default function DepartmentScreen() {
  const { dept = '' } = useParams()
  const sound = useSound()
  const q = usePublicScreen<PublicDepartment>(['department', dept], `/department/${encodeURIComponent(dept)}`, !!dept)
  const data = q.data
  const flash = useCallFlash(data, sound.play)

  useEffect(() => {
    if (data) document.title = `${data.department.name} · ${data.hospital}`
  }, [data])

  const lines = data?.queues ?? []
  const cols = tvColumns(lines.length)
  const notFound = q.error instanceof PublicError && q.error.status >= 400 && q.error.status < 500
  return (
    <TvScreen
      title={data ? data.department.name : 'Department screen'}
      subtitle={data ? `${data.hospital} · Outpatient consultations today` : undefined}
      sound={sound}
      offline={!!data && q.isError}
      flash={flash}
      footer={<Ticker note={NOTE} />}>
      {q.isLoading && <TvMessage>Loading…</TvMessage>}
      {!data && q.error && <TvMessage tone="warn">{notFound ? q.error.message : 'Display is offline — retrying…'}</TvMessage>}
      {data && lines.length === 0 && <TvMessage>No doctors are consulting in {data.department.name} today</TvMessage>}
      {lines.length > 0 && (
        <TvGrid count={lines.length}>
          {lines.map((b) => (
            <TvLineCard key={b.queue} line={b} cols={cols}
              title={b.doctor ?? b.name}
              meta={(b.room || b.sessions?.length) ? (
                <span className="flex flex-col items-end leading-tight">
                  {b.room && <span>Room {b.room}</span>}
                  {b.sessions?.length ? <span className="text-[clamp(11px,0.9vw,18px)] font-medium text-cyan-100/80">{b.sessions.join(', ')}</span> : null}
                </span>
              ) : null}
              hot={flash?.queue === b.queue} hotLabel={flash?.label} />
          ))}
        </TvGrid>
      )}
    </TvScreen>
  )
}
