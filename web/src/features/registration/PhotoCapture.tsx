import { Camera, ChevronDown, ImageUp, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button, MenuItem, Modal, Popover } from '@/components/ui'
import { apiUrl, errorMessage, uploadFile } from '@/lib/api'

const MAX = 5 * 1024 * 1024

export function photoUrl(id?: string | null) {
  return id ? apiUrl(`/files/${id}`, undefined, true) : null
}

/** "Upload photo" with a menu: upload JPG / PNG (≤ 5 MB) or take one with the camera. Returns a file id. */
export function PhotoButton({ value, onChange, patientId, disabled }: {
  value?: string | null; onChange: (id: string | null) => void; patientId?: string; disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [camera, setCamera] = useState(false)

  const upload = async (file: File) => {
    if (!/^image\/(jpeg|png)$/.test(file.type)) { toast.error('Use a JPG or PNG photo'); return }
    if (file.size > MAX) { toast.error('The photo is larger than 5 MB'); return }
    setBusy(true)
    try {
      const f = await uploadFile(file, patientId)
      onChange(f.id)
      toast.success('Photo added')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
      <Popover className="w-56" trigger={({ toggle, open }) => (
        <button type="button" onClick={toggle} disabled={disabled || busy} aria-expanded={open}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-2 bg-surface px-3 text-left shadow-sm hover:bg-surface-2 disabled:opacity-50">
          {value ? <img src={photoUrl(value)!} alt="" className="size-6 rounded object-cover" /> : busy ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4 text-ink-2" />}
          <span className="leading-tight">
            <span className="block text-sm font-medium text-ink">{value ? 'Photo added' : 'Upload photo'}</span>
            <span className="block text-[10px] text-ink-3">JPG, PNG up to 5 MB</span>
          </span>
          <ChevronDown className="size-4 text-ink-3" />
        </button>
      )}>
        {(close) => (
          <>
            <MenuItem icon="ImageUp" onClick={() => { close(); input.current?.click() }}>Upload from this computer</MenuItem>
            <MenuItem icon="Camera" disabled={typeof navigator.mediaDevices?.getUserMedia !== 'function'} onClick={() => { close(); setCamera(true) }}>Take photo with camera</MenuItem>
            {value && <MenuItem icon="Trash2" danger onClick={() => { close(); onChange(null) }}>Remove photo</MenuItem>}
          </>
        )}
      </Popover>
      {camera && <CameraModal onClose={() => setCamera(false)} onShot={(f) => { setCamera(false); void upload(f) }} />}
    </>
  )
}

function CameraModal({ onClose, onShot }: { onClose: () => void; onShot: (f: File) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<'starting' | 'live' | 'denied' | 'error'>('starting')
  const [shot, setShot] = useState<string | null>(null)
  const stream = useRef<MediaStream | null>(null)

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false })
      .then(async (s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        stream.current = s
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}) }
        setState('live')
      })
      .catch((e: DOMException) => setState(e?.name === 'NotAllowedError' ? 'denied' : 'error'))
    return () => { cancelled = true; stream.current?.getTracks().forEach((t) => t.stop()) }
  }, [])

  const take = () => {
    const v = video.current
    if (!v) return
    const side = Math.min(v.videoWidth, v.videoHeight)
    const c = document.createElement('canvas')
    c.width = 480
    c.height = 480
    c.getContext('2d')!.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, 480, 480)
    setShot(c.toDataURL('image/jpeg', 0.88))
  }
  const use = async () => {
    if (!shot) return
    const blob = await (await fetch(shot)).blob()
    onShot(new File([blob], `patient-photo-${Date.now()}.jpg`, { type: 'image/jpeg' }))
  }

  return (
    <Modal open onClose={onClose} title="Patient photo" size="md"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {shot ? <><Button onClick={() => setShot(null)}>Retake</Button><Button variant="primary" onClick={use}>Use this photo</Button></>
          : <Button variant="primary" icon="Camera" disabled={state !== 'live'} onClick={take}>Capture</Button>}
      </>}>
      <div className="mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-xl bg-slate-950">
        {shot ? <img src={shot} alt="Captured" className="h-full w-full object-cover" />
          : <video ref={video} playsInline muted className="h-full w-full object-cover" />}
      </div>
      {state === 'denied' && <p className="mt-3 text-sm text-red-600">Camera permission denied. Allow access in the address bar, or upload a photo instead.</p>}
      {state === 'error' && <p className="mt-3 text-sm text-red-600">The camera could not be started. Upload a photo instead.</p>}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-3"><ImageUp className="size-3.5" />Face the camera, plain background, no caps or dark glasses.</p>
    </Modal>
  )
}
