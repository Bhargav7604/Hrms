import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { DefsResponse, Entry, EntryRow, FormDef } from './types'

/** Query keys start with ['x', 'emr', …] so realtime change events on emr records refresh them. */
export const fk = {
  all: ['x', 'emr', 'forms'] as const,
  defs: (patientId?: string, encounterId?: string, bookingId?: string) => ['x', 'emr', 'forms', 'defs', patientId ?? '', encounterId ?? '', bookingId ?? ''] as const,
  def: (key: string) => ['forms-def', key] as const,
  entry: (id: string) => ['x', 'emr', 'forms', 'entry', id] as const,
  entries: (q: Record<string, unknown>) => ['x', 'emr', 'forms', 'entries', q] as const,
  scores: (patientId: string, encounterId?: string) => ['x', 'emr', 'forms', 'scores', patientId, encounterId ?? ''] as const,
  booklet: (patientId: string, encounterId?: string, bookingId?: string) => ['x', 'emr', 'forms', 'booklet', patientId, encounterId ?? '', bookingId ?? ''] as const,
  io: (q: Record<string, unknown>) => ['x', 'emr', 'forms', 'io', q] as const,
  templates: (formKey?: string, field?: string) => ['x', 'emr', 'forms', 'templates', formKey ?? '', field ?? ''] as const,
}

export function useFormDefs(patientId?: string, encounterId?: string) {
  return useQuery({
    queryKey: fk.defs(patientId, encounterId),
    queryFn: () => api<DefsResponse>('/forms/defs', { query: { patient_id: patientId, encounter_id: encounterId } }),
    staleTime: 30_000,
  })
}

export function useFormDef(key?: string | null) {
  return useQuery({
    queryKey: fk.def(key ?? ''),
    queryFn: () => api<FormDef>(`/forms/defs/${key}`),
    enabled: !!key,
    staleTime: 10 * 60_000,
  })
}

export function useEntry(id?: string | null) {
  return useQuery({ queryKey: fk.entry(id ?? ''), queryFn: () => api<Entry>(`/forms/entries/${id}`), enabled: !!id })
}

export function useEntries(q: { patient_id?: string; encounter_id?: string; form_key?: string; suite?: string; status?: string; booking_id?: string; limit?: number; days?: number; mine?: boolean }, enabled = true) {
  return useQuery({
    queryKey: fk.entries(q),
    queryFn: () => api<{ rows: EntryRow[] }>('/forms/entries', { query: q as Record<string, string | number | boolean | undefined> }),
    enabled: enabled && !!(q.patient_id || q.encounter_id || q.booking_id || q.mine || q.days),
  })
}

export function useInvalidateForms() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: fk.all })
  }
}
