import { useEffect } from 'react'
import { useParams } from 'react-router'
import type { PublicBoard } from './types'
import { PublicError, Ticker, tvColumns, TvGrid, TvLineCard, TvMessage, TvScreen, useCallFlash, usePublicScreen, useSound } from './tv'

const NOTE = 'Emergency, senior citizen and differently-abled patients are served first · Keep your token slip ready'

/**
 * A configured display board (Queue Management › Display Boards) at /queue/board/<code>: the board's
 * queues (and its department's doctor cabins) with now serving, next tokens and waiting counts.
 * Public data only — token numbers, counters and rooms.
 */
export default function DisplayBoardScreen() {
  const { code = '' } = useParams()
  const sound = useSound()
  const q = usePublicScreen<PublicBoard>(['board', code], `/board/${encodeURIComponent(code)}`, !!code)
  const data = q.data
  const announce = data?.board.announce !== false
  const flash = useCallFlash(data, sound.play, announce)

  useEffect(() => {
    if (data) document.title = `${data.board.name} · ${data.hospital}`
  }, [data])

  const lines = data?.queues ?? []
  const cols = tvColumns(lines.length)
  const notFound = q.error instanceof PublicError && q.error.status >= 400 && q.error.status < 500
  return (
    <TvScreen
      title={data?.hospital ?? 'Token display'}
      subtitle={data ? [data.board.name, data.board.location].filter(Boolean).join(' · ') : 'Please wait for your token number to be called'}
      sound={announce ? sound : undefined}
      offline={!!data && q.isError}
      flash={flash}
      footer={<Ticker text={data?.board.ticker} note={NOTE} />}>
      {q.isLoading && <TvMessage>Loading…</TvMessage>}
      {!data && q.error && <TvMessage tone="warn">{notFound ? q.error.message : 'Display is offline — retrying…'}</TvMessage>}
      {data && lines.length === 0 && <TvMessage>No queues on this board today</TvMessage>}
      {lines.length > 0 && (
        <TvGrid count={lines.length}>
          {lines.map((b) => (
            <TvLineCard key={b.queue} line={b} cols={cols} title={b.name} meta={b.kind === 'doctor' ? b.room : null}
              hot={flash?.queue === b.queue} hotLabel={flash?.label} />
          ))}
        </TvGrid>
      )}
    </TvScreen>
  )
}
