import { Camera, Keyboard, Loader2, ScanLine, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, cn, Modal, Segmented, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import type { AadhaarData } from './api'

/** Minimal typing for the Shape Detection API (Chrome / Edge / Android). */
interface DetectedBarcode { rawValue: string; format: string }
interface BarcodeDetectorLike { detect: (src: CanvasImageSource) => Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike

function detectorCtor(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  return w.BarcodeDetector ?? null
}

type Mode = 'camera' | 'usb'

/**
 * Scan the Aadhaar QR (Secure QR on the letter / e-Aadhaar / mAadhaar, or the older XML QR) from the
 * camera — it reads automatically — or from a USB / Bluetooth scanner that types the payload.
 * Decoding happens on the server; nothing is stored.
 */
export function AadhaarScanModal({ open, onClose, onRead }: { open: boolean; onClose: () => void; onRead: (d: AadhaarData) => void }) {
  const [mode, setMode] = useState<Mode>(() => (detectorCtor() && typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'camera' : 'usb'))
  const [state, setState] = useState<'idle' | 'starting' | 'scanning' | 'denied' | 'unsupported' | 'error' | 'decoding'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [text, setText] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const loop = useRef<number | null>(null)
  const busy = useRef(false)

  const stop = useCallback(() => {
    if (loop.current) window.clearInterval(loop.current)
    loop.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }, [])

  const decode = useCallback(async (raw: string) => {
    if (busy.current) return
    busy.current = true
    setState('decoding')
    setMessage(null)
    try {
      const d = await api<AadhaarData>('/registration/aadhaar/decode', { method: 'POST', body: { data: raw.trim() } })
      stop()
      onRead(d)
    } catch (e) {
      setMessage(errorMessage(e))
      setState(mode === 'camera' && stream.current ? 'scanning' : 'error')
    } finally {
      busy.current = false
    }
  }, [mode, onRead, stop])

  const capture = useCallback(async (manual = false) => {
    const Ctor = detectorCtor()
    const v = video.current
    if (!Ctor || !v || v.readyState < 2 || busy.current) return
    try {
      const codes = await new Ctor({ formats: ['qr_code'] }).detect(v)
      const hit = codes.find((c) => c.rawValue && c.rawValue.length > 20)
      if (hit) await decode(hit.rawValue)
      else if (manual) setMessage('No QR found in the frame — hold the card steady, fill the frame and avoid glare.')
    } catch {
      if (manual) setMessage('Could not read the frame. Try again or use USB / Paste.')
    }
  }, [decode])

  useEffect(() => {
    if (!open || mode !== 'camera') { stop(); return }
    if (!detectorCtor() || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setState('unsupported')
      return
    }
    let cancelled = false
    setState('starting')
    setMessage(null)
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        stream.current = s
        if (video.current) {
          video.current.srcObject = s
          await video.current.play().catch(() => {})
        }
        setState('scanning')
        loop.current = window.setInterval(() => { void capture(false) }, 450)
      })
      .catch((e: DOMException) => {
        if (cancelled) return
        setState(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'error')
        setMessage(e?.name === 'NotFoundError' ? 'No camera was found on this device.' : null)
      })
    return () => { cancelled = true; stop() }
  }, [open, mode, capture, stop])

  useEffect(() => { if (!open) { setText(''); setMessage(null); setState('idle') } }, [open])

  return (
    <Modal open={open} onClose={() => { stop(); onClose() }} size="lg" title={<span className="flex items-center gap-2"><ScanLine className="size-5" /> Scan Aadhaar QR</span>}
      footer={mode === 'usb' ? (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="ScanLine" disabled={text.trim().length < 20} loading={state === 'decoding'} onClick={() => decode(text)}>Read QR data</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="Camera" disabled={state !== 'scanning'} loading={state === 'starting' || state === 'decoding'} onClick={() => capture(true)}>
            {state === 'starting' ? 'Starting camera…' : 'Capture & read'}
          </Button>
        </>
      )}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-2">
            {mode === 'camera' ? 'Hold the Aadhaar QR inside the frame — it reads automatically.' : 'Click the box and scan with a USB / Bluetooth QR scanner, or paste the QR text.'}
          </p>
          <Segmented<Mode> value={mode} onChange={setMode} options={[{ key: 'camera', label: 'Camera' }, { key: 'usb', label: 'USB / Paste' }]} />
        </div>
        {mode === 'camera' ? (
          <>
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-slate-950">
              <video ref={video} playsInline muted className={cn('h-full w-full object-cover', state !== 'scanning' && state !== 'decoding' && 'opacity-30')} />
              <div className="pointer-events-none absolute inset-[12%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(2,6,23,0.35)]" />
              {(state === 'starting' || state === 'decoding') && (
                <div className="absolute inset-0 grid place-items-center text-sm text-white"><span className="flex items-center gap-2"><Loader2 className="size-5 animate-spin" />{state === 'starting' ? 'Starting camera…' : 'Reading…'}</span></div>
              )}
              {(state === 'denied' || state === 'unsupported' || state === 'error') && (
                <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white">
                  <div className="max-w-md space-y-3">
                    <ShieldAlert className="mx-auto size-8 text-amber-300" />
                    <p>{state === 'denied' ? 'Camera permission denied. Allow camera access in the address bar, or use the USB / Paste option.'
                      : state === 'unsupported' ? 'This browser cannot read QR codes from the camera. Use a USB scanner or paste the QR data (or open this page in Chrome / Edge).'
                        : message ?? 'The camera could not be started.'}</p>
                    <Button size="sm" onClick={() => setMode('usb')}><Keyboard className="size-4" /> Use USB / Paste</Button>
                  </div>
                </div>
              )}
            </div>
            <p className="flex items-center gap-1.5 text-xs text-ink-3"><Camera className="size-3.5" /> A rear camera or a USB scanner reads the dense Secure QR best. Press Capture & read only if it does not catch.</p>
          </>
        ) : (
          <Textarea rows={6} autoFocus value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs"
            placeholder="Secure QR: a long number (e.g. 47863901…) · Older QR: <PrintLetterBarcodeData uid=… name=… />"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && text.trim().length > 20) { e.preventDefault(); void decode(text) } }} />
        )}
        {message && state !== 'denied' && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{message}</p>}
        <p className="text-xs text-ink-3">The QR's digital signature is not verified offline — check the card against the patient. Only the last 4 Aadhaar digits are kept.</p>
      </div>
    </Modal>
  )
}
