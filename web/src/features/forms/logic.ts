/**
 * Live form evaluation — the same rules as backend/app/forms/logic.py (conditions, computed values, scoring,
 * risk bands). The server re-validates and re-scores on every save; its result is what gets stored.
 */
import { format } from 'date-fns'
import type { Answers, Band, Cond, FormDef, FormField, Option, Range } from './types'

export const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const t = (x: unknown) => x === true || x === 'Yes'
    const f = (x: unknown) => x === false || x === 'No'
    return a === b || (t(a) && t(b)) || (f(a) && f(b))
  }
  const na = num(a), nb = num(b)
  if (na !== null && nb !== null) return na === nb
  return a === b
}

export function condOk(c: Cond | undefined | null, values: Answers): boolean {
  if (!c) return true
  if (c.all && !c.all.every((x) => condOk(x, values))) return false
  if (c.any && !c.any.some((x) => condOk(x, values))) return false
  if (!c.field) return true
  const v = values[c.field]
  if (c.truthy !== undefined) {
    const ok = !isEmpty(v) && v !== false && v !== 'No'
    if (ok !== c.truthy) return false
  }
  if (('ne' in c || 'nin' in c) && isEmpty(v)) return false
  if ('eq' in c && !same(v, c.eq)) return false
  if ('ne' in c && same(v, c.ne)) return false
  const inList = (list: unknown[]) => list.some((x) => same(x, v)) || (Array.isArray(v) && list.some((x) => v.includes(x)))
  if (c.in && !inList(c.in)) return false
  if (c.nin && inList(c.nin)) return false
  const n = num(v)
  for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
    const t = c[op]
    if (t === undefined) continue
    if (n === null) return false
    if ((op === 'gt' && !(n > t)) || (op === 'gte' && !(n >= t)) || (op === 'lt' && !(n < t)) || (op === 'lte' && !(n <= t))) return false
  }
  return true
}

export const inRange = (v: number, r: Range | Band) =>
  (r.min === undefined || r.min === null || v >= r.min) && (r.max === undefined || r.max === null || v <= r.max) && (r.lt === undefined || r.lt === null || v < r.lt)

export const optionOf = (f: FormField, value: unknown): Option | undefined =>
  (f.options ?? []).find((o): o is Option => typeof o === 'object' && o.value === value)

export const optionValues = (f: FormField): string[] => (f.options ?? []).map((o) => (typeof o === 'string' ? o : o.value))

export function itemScore(f: FormField | undefined, v: unknown): number | null {
  if (!f || isEmpty(v)) return null
  if (f.type === 'choice') return optionOf(f, v)?.score ?? null
  if (f.score_map) return f.score_map[String(v)] ?? null
  const n = num(v)
  if (n === null) return null
  if (f.score_ranges?.length) return f.score_ranges.find((r) => inRange(n, r))?.score ?? null
  if (f.score_value) return n
  return null
}

// ------------------------------------------------------------------ computed values

function toDate(v: unknown): Date | null {
  if (isEmpty(v)) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

function minutesBetween(a: unknown, b: unknown): number | null {
  if (typeof a === 'string' && typeof b === 'string' && /^\d\d:\d\d$/.test(a) && /^\d\d:\d\d$/.test(b)) {
    const ma = Number(a.slice(0, 2)) * 60 + Number(a.slice(3)), mb = Number(b.slice(0, 2)) * 60 + Number(b.slice(3))
    return (((mb - ma) % 1440) + 1440) % 1440
  }
  const da = toDate(a), db = toDate(b)
  return da && db ? (db.getTime() - da.getTime()) / 60000 : null
}

const round = (n: number, d: number) => { const p = 10 ** d; return Math.round(n * p) / p }

export function compute(fn: string, args: string[], values: Answers, fmap: Map<string, FormField>, decimals = 1): number | null {
  const vals = args.map((a) => values[a])
  const nums = vals.map(num)
  let out: number | null = null
  const present = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null)
  switch (fn) {
    case 'sum': { const p = present(nums); out = p.length ? p.reduce((a, b) => a + b, 0) : null; break }
    case 'diff': out = nums.length === 2 && nums[0] !== null && nums[1] !== null ? nums[0] - nums[1] : null; break
    case 'product': out = nums.length && nums.every((x) => x !== null) ? (nums as number[]).reduce((a, b) => a * b, 1) : null; break
    case 'ratio': case 'percent':
      out = nums.length === 2 && nums[0] !== null && nums[1] ? (nums[0] / nums[1]) * (fn === 'percent' ? 100 : 1) : null; break
    case 'bmi': { const [w, h] = nums; out = w && h && h > 30 ? w / (h / 100) ** 2 : null; break }
    case 'bsa': { const [h, w] = nums; out = h && w && h > 30 ? Math.sqrt((h * w) / 3600) : null; break }
    case 'map': { const [s, d] = nums; out = s !== null && d !== null ? (s + 2 * d) / 3 : null; break }
    case 'score_sum': { const p = present(args.map((a) => itemScore(fmap.get(a), values[a]))); out = p.length ? p.reduce((a, b) => a + b, 0) : null; break }
    case 'count_yes': out = vals.some((v) => !isEmpty(v)) ? vals.filter((v) => v === 'Yes' || v === true).length : null; break
    case 'percent_yes': {
      const yes = vals.filter((v) => v === 'Yes' || v === true).length, no = vals.filter((v) => v === 'No' || v === false).length
      out = yes + no ? (yes / (yes + no)) * 100 : null; break
    }
    case 'lines_sum': case 'lines_count': case 'lines_nonzero': {
      const rows = Array.isArray(values[args[0]]) ? (values[args[0]] as Answers[]) : []
      if (fn === 'lines_count') { out = rows.length || null; break }
      const cells = rows.map((r) => num(r?.[args[1]]))
      if (fn === 'lines_sum') { const p = present(cells); out = p.length ? p.reduce((a, b) => a + b, 0) : null }
      else out = rows.length ? cells.filter((c) => c !== null && c !== 0).length : null
      break
    }
    case 'minutes_between': out = minutesBetween(vals[0], vals[1]); break
    case 'hours_since': { const d = toDate(vals[0]); out = d ? (Date.now() - d.getTime()) / 3.6e6 : null; break }
    case 'days_since': {
      const d = toDate(vals[0])
      if (d) { const t = new Date(); t.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); out = Math.round((t.getTime() - x.getTime()) / 864e5) }
      break
    }
    case 'weight_change_pct': { const [a, b] = nums; out = a && b !== null ? ((b - a) / a) * 100 : null; break }
  }
  return out === null || !Number.isFinite(out) ? null : round(out, decimals)
}

export function fieldMap(def: FormDef): Map<string, FormField> {
  return new Map(def.sections.flatMap((s) => s.fields.map((f) => [f.key, f] as const)))
}

export function applyComputed(def: FormDef, values: Answers, fmap = fieldMap(def)): Answers {
  const out: Answers = { ...values }
  for (let pass = 0; pass < 3; pass++) {
    for (const f of fmap.values()) {
      if (f.type === 'lines' && Array.isArray(out[f.key])) {
        const sub = new Map((f.fields ?? []).map((s) => [s.key, s]))
        const all = new Map([...fmap, ...sub])
        out[f.key] = (out[f.key] as Answers[]).map((row) => {
          const r = { ...row }
          for (const s of f.fields ?? []) if (s.type === 'computed' && s.compute) r[s.key] = compute(s.compute.fn, s.compute.args, { ...out, ...r }, all, s.compute.decimals ?? 1)
          return r
        })
      } else if (f.type === 'computed' && f.compute) {
        out[f.key] = compute(f.compute.fn, f.compute.args, out, fmap, f.compute.decimals ?? 1)
      }
    }
  }
  return out
}

export function visibleKeys(def: FormDef, values: Answers): Set<string> {
  const keys = new Set<string>()
  for (const s of def.sections) {
    if (!condOk(s.show_if, values)) continue
    for (const f of s.fields) if (condOk(f.show_if, values)) keys.add(f.key)
  }
  return keys
}

export interface Evaluation {
  values: Answers
  score: number | null
  band: Band | null
  complete: boolean
  items: Record<string, number | null>
  counts?: { yes: number; no: number; na: number; total: number }
  answered: number
  total: number
}

export function evaluate(def: FormDef, answers: Answers): Evaluation {
  const fmap = fieldMap(def)
  const values = applyComputed(def, answers, fmap)
  const res: Evaluation = { values, score: null, band: null, complete: false, items: {}, answered: 0, total: 0 }
  const sc = def.score
  if (!sc) return res
  const vis = visibleKeys(def, values)
  const items = sc.items.filter((k) => vis.has(k))
  res.total = items.length
  let score: number | null = null
  if (sc.method === 'percent_yes' || sc.method === 'count_yes') {
    const answered = items.map((k) => values[k]).filter((v) => !isEmpty(v))
    const yes = answered.filter((v) => v === 'Yes' || v === true).length
    const no = answered.filter((v) => v === 'No' || v === false).length
    score = sc.method === 'percent_yes' ? (yes + no ? (yes / (yes + no)) * 100 : null) : answered.length ? yes : null
    res.counts = { yes, no, na: answered.length - yes - no, total: items.length }
    res.answered = answered.length
    for (const k of items) res.items[k] = values[k] === 'Yes' ? 1 : values[k] === 'No' ? 0 : null
  } else {
    for (const k of items) res.items[k] = itemScore(fmap.get(k), values[k])
    const present = Object.values(res.items).filter((v): v is number => v !== null)
    res.answered = present.length
    if (present.length) {
      score = sc.method === 'sum' ? present.reduce((a, b) => a + b, 0) : sc.method === 'max' ? Math.max(...present)
        : sc.method === 'min' ? Math.min(...present) : present[0]
    }
  }
  res.complete = items.length > 0 && res.answered === items.length
  if (score !== null) {
    score = round(score, sc.decimals ?? 0)
    res.score = score
    res.band = def.bands.find((b) => inRange(score!, b)) ?? null
  }
  return res
}

/** Required + visible fields that are still empty (client-side pre-check before signing). */
export function missingRequired(def: FormDef, values: Answers): Record<string, string> {
  const vis = visibleKeys(def, values)
  const out: Record<string, string> = {}
  for (const s of def.sections) for (const f of s.fields) {
    if (!vis.has(f.key) || f.type === 'computed' || f.type === 'info' || f.readonly) continue
    const need = f.required || (f.required_if ? condOk(f.required_if, values) : false)
    if (need && isEmpty(values[f.key])) out[f.key] = `${f.label} is required`
  }
  return out
}

/** Client defaults: literal, "now", "today", "me". */
export function defaultsFor(def: FormDef, me: string | null): Answers {
  const out: Answers = {}
  for (const s of def.sections) for (const f of s.fields) {
    const d = f.default
    if (d === undefined || d === null) continue
    if (d === 'now') out[f.key] = f.type === 'time' ? format(new Date(), 'HH:mm') : format(new Date(), "yyyy-MM-dd'T'HH:mm")
    else if (d === 'today') out[f.key] = format(new Date(), 'yyyy-MM-dd')
    else if (d === 'me') { if (me) out[f.key] = me }
    else out[f.key] = d
  }
  return out
}

export function formatAnswer(f: FormField | undefined, v: unknown, refs: Record<string, string> = {}): string {
  if (isEmpty(v)) return ''
  if (!f) return String(v)
  if (f.type === 'lines' && Array.isArray(v)) {
    return (v as Answers[]).map((row) => (f.fields ?? []).map((s) => formatAnswer(s, row?.[s.key], refs)).filter(Boolean).join(' · ')).filter(Boolean).join('\n')
  }
  if (Array.isArray(v)) return v.join(', ')
  if (f.type === 'ref') return refs[String(v)] ?? '…'
  if (f.type === 'boolean') return v ? 'Yes' : 'No'
  if (f.type === 'choice') { const o = optionOf(f, v); return o ? (o.label ?? o.value) : String(v) }
  if (f.type === 'datetime') { const d = toDate(v); return d ? format(d, 'dd MMM yyyy, HH:mm') : String(v) }
  if (f.type === 'date') { const d = toDate(v); return d ? format(d, 'dd MMM yyyy') : String(v) }
  if (f.type === 'signature' || f.type === 'file') return 'Attached'
  if (f.unit && typeof v === 'number') return `${v} ${f.unit}`
  return String(v)
}

export const TONE_RING: Record<string, string> = {
  green: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100',
  amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
  red: 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100',
  blue: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100',
  gray: 'border-line-2 bg-surface-2 text-ink',
  violet: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100',
  cyan: 'border-cyan-300 bg-cyan-50 text-cyan-900 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-100',
  pink: 'border-pink-300 bg-pink-50 text-pink-900 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-100',
}

/** Section header tint (light + dark). */
export const SECTION_TINT: Record<string, string> = {
  blue: 'bg-sky-50/70 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200',
  pink: 'bg-pink-50/70 text-pink-900 dark:bg-pink-500/10 dark:text-pink-200',
  green: 'bg-emerald-50/70 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
  amber: 'bg-amber-50/70 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
  violet: 'bg-violet-50/70 text-violet-900 dark:bg-violet-500/10 dark:text-violet-200',
  red: 'bg-red-50/70 text-red-900 dark:bg-red-500/10 dark:text-red-200',
  cyan: 'bg-cyan-50/70 text-cyan-900 dark:bg-cyan-500/10 dark:text-cyan-200',
  gray: 'bg-surface-2 text-ink',
}

export const badgeTone = (t?: string | null): 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet' | 'cyan' =>
  t === 'green' || t === 'amber' || t === 'red' || t === 'blue' || t === 'violet' || t === 'cyan' ? t : t === 'pink' ? 'red' : 'gray'
