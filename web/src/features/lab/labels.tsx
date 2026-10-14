import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, Modal } from '@/components/ui'
import { dateTime } from '@/lib/format'

// Code 128 (B / C) bar patterns — same encoding as the worklist labels (not exported there).
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232',
  '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221',
  '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113',
  '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123',
  '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221',
  '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241',
  '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311',
  '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112']

function code128(text: string): number[] {
  const numeric = /^\d+$/.test(text) && text.length % 2 === 0
  const codes = numeric
    ? [105, ...Array.from({ length: text.length / 2 }, (_, i) => Number(text.slice(i * 2, i * 2 + 2)))]
    : [104, ...[...text].map((ch) => Math.min(94, Math.max(0, ch.charCodeAt(0) - 32)))]
  const check = codes.reduce((sum, c, i) => sum + (i === 0 ? c : c * i), 0) % 103
  return [...codes, check, 106].flatMap((c) => C128[c].split('').map(Number))
}

export function Barcode({ value, className = 'h-[9mm] w-full' }: { value: string; className?: string }) {
  const widths = code128(value)
  const quiet = 10
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2
  const bars: ReactNode[] = []
  let x = quiet
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={w} height={40} />)
    x += w
  })
  return <svg viewBox={`0 0 ${total} 40`} preserveAspectRatio="none" shapeRendering="crispEdges" className={className} fill="#000" aria-label={`Barcode ${value}`}>{bars}</svg>
}

export interface SampleLabel {
  barcode: string; patient: { name: string; uhid?: string | null; age?: number | null; gender?: string | null }; tests: string[]
  order_codes: string[]; sample_type?: string | null; container?: string | null; collected_at?: string | null; priority: string
}

const LABEL_CSS = `
.w7-labels { display: none; }
@media print {
  @page { size: 50mm 25mm; margin: 0; }
  body > *:not(.w7-labels) { display: none !important; }
  .w7-labels { display: block !important; }
  .w7-label { width: 50mm; height: 25mm; padding: 1mm 2mm; box-sizing: border-box; break-after: page; overflow: hidden;
    font: 7pt/1.15 system-ui, sans-serif; color: #000; background: #fff; }
}`

function LabelBody({ l }: { l: SampleLabel }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: '34mm' }}>{l.patient.name}</span>
        <span>{l.priority === 'STAT' ? 'STAT' : ''}</span>
      </div>
      <div>{l.patient.uhid} · {l.patient.age != null ? `${l.patient.age}y` : ''} {l.patient.gender?.[0] ?? ''} · {l.collected_at ? dateTime(l.collected_at) : ''}</div>
      <Barcode value={l.barcode} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><b style={{ letterSpacing: '0.5px' }}>{l.barcode}</b><span>{l.container ?? l.sample_type ?? ''}</span></div>
      <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{l.tests.join(', ')}</div>
    </>
  )
}

/** 50 × 25 mm tube labels: preview in a modal; the print stylesheet prints only the labels. */
export function LabelPrint({ labels, onClose, autoPrint = true }: { labels: SampleLabel[]; onClose: () => void; autoPrint?: boolean }) {
  useEffect(() => {
    if (!autoPrint) return
    const t = setTimeout(() => window.print(), 300)
    return () => clearTimeout(t)
  }, [labels, autoPrint])
  const patients = new Set(labels.map((l) => l.patient.uhid)).size
  return (
    <>
      <style>{LABEL_CSS}</style>
      {createPortal(<div className="w7-labels">{labels.map((l) => <div key={l.barcode} className="w7-label"><LabelBody l={l} /></div>)}</div>, document.body)}
      <Modal open onClose={onClose} size="lg" title={`${labels.length} tube label${labels.length === 1 ? '' : 's'} · ${patients} patient${patients === 1 ? '' : 's'}`}
        footer={<><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary" icon="Printer" onClick={() => window.print()}>Print labels</Button></>}>
        <div className="flex flex-wrap gap-3">
          {labels.map((l) => (
            <div key={l.barcode} className="w-[200px] rounded border border-line bg-white p-2 text-[11px] leading-tight text-black shadow-sm"><LabelBody l={l} /></div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-3">Printed at 50 × 25 mm. Stick the label lengthwise with the barcode readable; tests that share a container share a tube.</p>
      </Modal>
    </>
  )
}
