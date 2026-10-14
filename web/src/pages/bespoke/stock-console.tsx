import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { Bars, ChartFrame } from '@/components/charts'
import { NewButton, useEntity } from '@/components/records'
import {
  Badge, Card, cn, Drawer, Empty, ErrorBox, FieldWrap, KeyValue, Segmented, Select, Spinner, StatTile, StatusBadge, Tabs, type BadgeTone,
} from '@/components/ui'
import { api } from '@/lib/api'
import { date, dateTime, money, moneyShort, number } from '@/lib/format'
import type { BespokeProps } from './index'

interface BatchRow { id: string; item_id: string; item: string; code?: string; store: string; batch?: string | null; expiry?: string | null; days_left?: number | null; qty: number; uom?: string; value: number; status?: string }
interface ReorderRow { item_id: string; item: string; code?: string; type?: string; uom?: string; store?: string | null; qty: number; reorder_level: number; shortfall: number; suggested_qty: number; ved?: string | null }
interface Move { id: string; at: string; item_id: string; item: string; store: string; batch?: string | null; qty: number; uom?: string; kind: string; ref?: string | null; ref_fqn?: string | null; ref_id?: string | null; balance?: number | null; user?: string | null }
interface Console {
  store: string | null
  stores: string[]
  as_of: string
  kpis: { stock_value: number; mrp_value: number; below_reorder: number; near_expiry: number; near_expiry_value: number; expired: number; expired_value: number }
  by_store: { store: string; batches: number; value: number; mrp_value: number; expired_value: number }[]
  reorder: ReorderRow[]
  near_expiry: BatchRow[]
  expired: BatchRow[]
  top_consumption: { item_id: string; item: string; uom?: string; qty: number; moves: number }[]
  recent_moves: Move[]
}
interface ItemStock {
  item: Record<string, string | number | boolean | null>
  batches: { id: string; code: string; store: string; batch?: string | null; expiry?: string | null; days_left?: number | null; qty: number; rate: number; mrp: number; status: string; usable: boolean }[]
  stores: { store: string; qty: number; usable_qty: number; value: number; batches: number }[]
  fefo_batch: { batch?: string | null; store: string; expiry?: string | null } | null
  reorder_levels: { store: string; reorder_level: number; min_level?: number; max_level?: number }[]
  moves: Move[]
}

const KIND_TONE: Record<string, BadgeTone> = {
  GRN: 'green', RETURN: 'green', TRANSFER_IN: 'cyan', TRANSFER_OUT: 'cyan', DISPENSE: 'blue', ISSUE: 'violet', CONSUME: 'violet', ADJUST: 'amber',
}
const KIND_LABEL: Record<string, string> = {
  GRN: 'GRN', RETURN: 'Return', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out', DISPENSE: 'Dispense', ISSUE: 'Ward issue', CONSUME: 'Consumption', ADJUST: 'Adjustment',
}
const REF_LINK: Record<string, string> = {
  'procurement.grns': '/m/procurement/grns', 'inventory.transfers': '/m/inventory/transfers', 'inventory.consumption': '/m/inventory/consumption',
  'inventory.adjustments': '/m/inventory/adjustments', 'pharmacy.dispenses': '/m/pharmacy/dispenses', 'pharmacy.returns': '/m/pharmacy/returns',
  'pharmacy.indents': '/m/pharmacy/indents',
}

export default function StockConsole(_: BespokeProps) {
  const [store, setStore] = useState('')
  const [tab, setTab] = useState<'reorder' | 'expiry' | 'moves'>('reorder')
  const [item, setItem] = useState<string | null>(null)
  const grn = useEntity('procurement.grns')
  const transfer = useEntity('inventory.transfers')
  const adjustment = useEntity('inventory.adjustments')
  const consumption = useEntity('inventory.consumption')
  const q = useQuery({
    queryKey: ['x', 'inventory', 'console', store],
    queryFn: () => api<Console>('/inventory/console', { query: { store: store || undefined } }),
    refetchInterval: 120_000,
    placeholderData: (p) => p,
  })
  const d = q.data
  return (
    <div className="space-y-4">
      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <FieldWrap label="Store" className="w-60">
            <Select value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">All stores</option>
              {(d?.stores ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </FieldWrap>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <NewButton entity={grn} label="GRN" />
            <NewButton entity={transfer} label="Transfer" variant="secondary" fixed={store ? { from_store: store } : undefined} />
            <NewButton entity={consumption} label="Consumption" variant="secondary" fixed={store ? { store } : undefined} />
            <NewButton entity={adjustment} label="Adjustment" variant="secondary" fixed={store ? { store } : undefined} />
            <Link to="/m/procurement/purchase_orders" className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-brand-700 hover:bg-surface-2 dark:text-brand-300">Purchase orders</Link>
          </div>
        </div>
      </Card>
      {q.isLoading && <Spinner label="Reading stock ledger…" />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile icon="IndianRupee" label="Stock value (purchase rate)" value={moneyShort(d.kpis.stock_value)} hint={`${moneyShort(d.kpis.mrp_value)} at MRP`} />
            <StatTile icon="TrendingDown" label="Below reorder level" value={d.kpis.below_reorder} tone={d.kpis.below_reorder ? 'alert' : 'default'} onClick={() => setTab('reorder')} />
            <StatTile icon="CalendarClock" label="Expiring ≤ 90 days" value={d.kpis.near_expiry} hint={`${moneyShort(d.kpis.near_expiry_value)} at risk`} onClick={() => setTab('expiry')} />
            <StatTile icon="CalendarX2" label="Expired batches on hand" value={d.kpis.expired} hint={d.kpis.expired ? `${moneyShort(d.kpis.expired_value)} to write off` : 'none'}
              tone={d.kpis.expired ? 'alert' : 'default'} onClick={() => setTab('expiry')} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {d.by_store.length > 1 ? (
              <ChartFrame title="Stock value by store" subtitle="₹ at purchase rate" height={Math.max(160, d.by_store.length * 34)}
                table={{ columns: ['Store', 'Batches', 'Value', 'MRP value'], rows: d.by_store.map((s) => [s.store, s.batches, money(s.value), money(s.mrp_value)]) }}>
                <Bars data={d.by_store} x="store" horizontal series={[{ key: 'value', label: 'Stock value' }]} fmt={(v) => moneyShort(v)} />
              </ChartFrame>
            ) : (
              <Card title="Store" icon="Warehouse">
                {d.by_store[0] ? <KeyValue cols={2} items={[
                  { label: 'Store', value: d.by_store[0].store }, { label: 'Batches on hand', value: number(d.by_store[0].batches) },
                  { label: 'Value (purchase)', value: money(d.by_store[0].value) }, { label: 'Value (MRP)', value: money(d.by_store[0].mrp_value) },
                ]} /> : <Empty icon="Warehouse" title="No stock in this store" />}
              </Card>
            )}
            <Card title="Top consumption · last 30 days" icon="Flame" pad={false}>
              {d.top_consumption.length === 0 ? <Empty icon="Flame" title="No issues, dispenses or consumption yet" /> : (
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-surface-2 text-xs text-ink-2"><tr><th className="px-3 py-2 text-left font-medium">Item</th><th className="px-3 py-2 text-right font-medium">Quantity</th><th className="px-3 py-2 text-right font-medium">Transactions</th></tr></thead>
                  <tbody>{d.top_consumption.map((t) => (
                    <tr key={t.item_id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => setItem(t.item_id)}>
                      <td className="px-3 py-1.5 text-ink">{t.item}</td><td className="px-3 py-1.5 text-right tabular">{number(t.qty)} {t.uom}</td><td className="px-3 py-1.5 text-right tabular text-ink-2">{t.moves}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Card>
          </div>
          <Card pad={false}>
            <Tabs className="px-3" value={tab} onChange={setTab} tabs={[
              { key: 'reorder', label: 'Reorder', icon: 'TrendingDown', count: d.reorder.length },
              { key: 'expiry', label: 'Expiry', icon: 'CalendarClock', count: d.near_expiry.length + d.expired.length },
              { key: 'moves', label: 'Recent movements', icon: 'ArrowLeftRight' },
            ]} />
            {tab === 'reorder' && <ReorderTable rows={d.reorder} onItem={setItem} perStore={!!store} />}
            {tab === 'expiry' && <ExpiryTables near={d.near_expiry} expired={d.expired} onItem={setItem} />}
            {tab === 'moves' && <MovesTable rows={d.recent_moves} onItem={setItem} />}
          </Card>
          <p className="text-xs text-ink-3">As of {dateTime(d.as_of)} · stock below reorder counts only unexpired, unquarantined batches.</p>
        </>
      )}
      {item && <ItemDrawer id={item} store={store} onClose={() => setItem(null)} />}
    </div>
  )
}

function th(labels: string[], right: string[] = []) {
  return (
    <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
      <tr>{labels.map((l) => <th key={l} className={cn('whitespace-nowrap px-3 py-2 font-medium', right.includes(l) ? 'text-right' : 'text-left')}>{l}</th>)}</tr>
    </thead>
  )
}

function ReorderTable({ rows, onItem, perStore }: { rows: ReorderRow[]; onItem: (id: string) => void; perStore: boolean }) {
  if (!rows.length) return <Empty icon="CheckCircle2" title="Every item is above its reorder level" />
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full text-sm">
        {th(['Item', 'Type', perStore ? 'Store' : 'Scope', 'On hand', 'Reorder level', 'Shortfall', 'Suggested order'], ['On hand', 'Reorder level', 'Shortfall', 'Suggested order'])}
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.item_id}-${r.store ?? ''}`} onClick={() => onItem(r.item_id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
              <td className="px-3 py-1.5"><span className="font-medium text-ink">{r.item}</span> <span className="font-mono text-xs text-ink-3">{r.code}</span>{r.ved && <Badge tone="violet" className="ml-1">{r.ved}</Badge>}</td>
              <td className="px-3 py-1.5 text-ink-2">{r.type}</td>
              <td className="px-3 py-1.5 text-ink-2">{r.store ?? 'All stores'}</td>
              <td className="px-3 py-1.5 text-right tabular">{r.qty === 0 ? <Badge tone="red">Out of stock</Badge> : `${number(r.qty)} ${r.uom ?? ''}`}</td>
              <td className="px-3 py-1.5 text-right tabular text-ink-2">{number(r.reorder_level)}</td>
              <td className="px-3 py-1.5 text-right tabular font-medium text-red-700 dark:text-red-300">{number(r.shortfall)}</td>
              <td className="px-3 py-1.5 text-right tabular">{number(r.suggested_qty)} {r.uom ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ExpiryTables({ near, expired, onItem }: { near: BatchRow[]; expired: BatchRow[]; onItem: (id: string) => void }) {
  const [view, setView] = useState<'near' | 'expired'>(expired.length ? 'expired' : 'near')
  const adjustment = useEntity('inventory.adjustments')
  const rows = view === 'near' ? near : expired
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <Segmented value={view} onChange={setView} options={[{ key: 'expired', label: `Expired · ${expired.length}` }, { key: 'near', label: `≤ 90 days · ${near.length}` }]} />
        <span className="text-xs text-ink-3">{view === 'near' ? 'Dispense these first (FEFO is automatic), transfer to a faster-moving store or return to the supplier.' : 'Expired stock is never issued; write it off through an approved adjustment.'}</span>
      </div>
      {rows.length === 0 ? <Empty icon="CheckCircle2" title={view === 'near' ? 'Nothing expires in the next 90 days' : 'No expired stock on hand'} /> : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            {th(['Item', 'Store', 'Batch', 'Expiry', 'Qty', 'Value', ''], ['Qty', 'Value'])}
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="cursor-pointer px-3 py-1.5" onClick={() => onItem(b.item_id)}><span className="font-medium text-ink">{b.item}</span> <span className="font-mono text-xs text-ink-3">{b.code}</span></td>
                  <td className="px-3 py-1.5 text-ink-2">{b.store}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{b.batch ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{date(b.expiry)} <Badge tone={(b.days_left ?? 0) < 0 ? 'red' : (b.days_left ?? 0) <= 30 ? 'red' : 'amber'}>{(b.days_left ?? 0) < 0 ? `${-(b.days_left ?? 0)} d ago` : `${b.days_left} d`}</Badge></td>
                  <td className="px-3 py-1.5 text-right tabular">{number(b.qty)} {b.uom}</td>
                  <td className="px-3 py-1.5 text-right tabular">{money(b.value)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {view === 'expired' && <NewButton entity={adjustment} label="Write off" variant="secondary"
                      fixed={{ store: b.store, item: b.item_id, batch: b.batch, qty_change: -b.qty, reason: 'Expiry' }} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MovesTable({ rows, onItem, compact }: { rows: Move[]; onItem?: (id: string) => void; compact?: boolean }) {
  if (!rows.length) return <Empty icon="ArrowLeftRight" title="No stock movements yet">GRNs, transfers, dispenses, ward issues, returns and adjustments are all recorded in the stock ledger.</Empty>
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full text-sm">
        {th(compact ? ['When', 'Movement', 'Store', 'Batch', 'Qty', 'Balance', 'Reference'] : ['When', 'Movement', 'Item', 'Store', 'Batch', 'Qty', 'Balance', 'Reference', 'By'], ['Qty', 'Balance'])}
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{dateTime(m.at)}</td>
              <td className="px-3 py-1.5"><Badge tone={KIND_TONE[m.kind] ?? 'gray'}>{KIND_LABEL[m.kind] ?? m.kind}</Badge></td>
              {!compact && <td className="cursor-pointer px-3 py-1.5 text-ink hover:underline" onClick={() => onItem?.(m.item_id)}>{m.item}</td>}
              <td className="px-3 py-1.5 text-ink-2">{m.store}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{m.batch ?? '—'}</td>
              <td className={cn('px-3 py-1.5 text-right tabular font-medium', m.qty < 0 ? 'text-ink' : 'text-emerald-700 dark:text-emerald-300')}>{m.qty > 0 ? '+' : ''}{number(m.qty)}</td>
              <td className="px-3 py-1.5 text-right tabular text-ink-2">{m.balance !== null && m.balance !== undefined ? number(m.balance) : '—'}</td>
              <td className="px-3 py-1.5 text-xs">{m.ref_fqn && REF_LINK[m.ref_fqn] && m.ref_id
                ? <Link className="font-mono text-brand-700 hover:underline dark:text-brand-300" to={`${REF_LINK[m.ref_fqn]}?r=${m.ref_id}`}>{m.ref}</Link>
                : <span className="font-mono">{m.ref ?? '—'}</span>}</td>
              {!compact && <td className="px-3 py-1.5 text-xs text-ink-2">{m.user ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ItemDrawer({ id, store, onClose }: { id: string; store: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['x', 'inventory', 'item', id], queryFn: () => api<ItemStock>(`/inventory/items/${id}/stock`, { query: { include_empty: false } }) })
  const d = q.data
  return (
    <Drawer open onClose={onClose} width="max-w-3xl" title={d ? String(d.item.name) : 'Item stock'}
      subtitle={d && <span className="font-mono text-xs">{String(d.item.code)} · {String(d.item.type ?? '')} · {String(d.item.uom ?? '')}</span>}>
      {q.isLoading && <Spinner />}
      {q.error && <div className="p-5"><ErrorBox error={q.error} /></div>}
      {d && (
        <div className="space-y-5 p-5">
          <KeyValue cols={3} items={[
            { label: 'Generic', value: String(d.item.generic_name ?? '—') }, { label: 'Strength / form', value: [d.item.strength, d.item.form].filter(Boolean).join(' · ') || '—' },
            { label: 'Schedule', value: String(d.item.schedule ?? '—') }, { label: 'MRP', value: money(d.item.mrp) },
            { label: 'Purchase rate', value: money(d.item.purchase_rate) }, { label: 'Reorder level (master)', value: number(d.item.reorder_level) },
            { label: 'High-alert', value: d.item.high_alert ? <Badge tone="red">Yes</Badge> : 'No' }, { label: 'Status', value: <StatusBadge status={String(d.item.status ?? '')} /> },
            { label: 'Next to issue (FEFO)', value: d.fefo_batch ? `${d.fefo_batch.batch} · ${d.fefo_batch.store} · exp ${date(d.fefo_batch.expiry)}` : '—' },
          ]} />
          <div>
            <h4 className="mb-2 text-sm font-semibold text-ink">By store</h4>
            {d.stores.length === 0 ? <p className="text-sm text-ink-3">No stock in any store.</p> : (
              <div className="grid gap-2 sm:grid-cols-3">
                {d.stores.map((s) => (
                  <div key={s.store} className={cn('rounded-lg border px-3 py-2', s.store === store ? 'border-brand-600' : 'border-line')}>
                    <div className="text-xs text-ink-3">{s.store}</div>
                    <div className="text-lg font-semibold tabular text-ink">{number(s.usable_qty)}</div>
                    <div className="text-xs text-ink-3">{s.batches} batch{s.batches === 1 ? '' : 'es'} · {money(s.value)}{s.qty !== s.usable_qty ? ` · ${number(s.qty - s.usable_qty)} unusable` : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-ink">Batches</h4>
            <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
              <table className="w-full text-sm">
                {th(['Store', 'Batch', 'Expiry', 'Qty', 'Rate', 'MRP', 'Status'], ['Qty', 'Rate', 'MRP'])}
                <tbody>{d.batches.map((b) => (
                  <tr key={b.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-1.5 text-ink-2">{b.store}</td><td className="px-3 py-1.5 font-mono text-xs">{b.batch ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{date(b.expiry)}{b.days_left !== null && b.days_left !== undefined && b.days_left <= 90 && <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">({b.days_left} d)</span>}</td>
                    <td className="px-3 py-1.5 text-right tabular">{number(b.qty)}</td><td className="px-3 py-1.5 text-right tabular">{money(b.rate)}</td>
                    <td className="px-3 py-1.5 text-right tabular">{money(b.mrp)}</td><td className="px-3 py-1.5"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-ink">Recent movements</h4>
            <div className="rounded-lg border border-line"><MovesTable rows={d.moves} compact /></div>
          </div>
        </div>
      )}
    </Drawer>
  )
}
