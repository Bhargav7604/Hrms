/**
 * Minimal QR Code encoder (ISO/IEC 18004, model 2): byte mode, error-correction level M,
 * versions 1–10 (up to 213 bytes) — enough for portal / pre-registration links on posters.
 * Returns a square matrix of dark (true) / light (false) modules without the quiet zone.
 */

// [data codewords per block, number of blocks] for level M, versions 1..10, plus EC codewords per block.
const BLOCKS: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[16, 1]] },
  { ec: 16, groups: [[28, 1]] },
  { ec: 26, groups: [[44, 1]] },
  { ec: 18, groups: [[32, 2]] },
  { ec: 24, groups: [[43, 2]] },
  { ec: 16, groups: [[27, 4]] },
  { ec: 18, groups: [[31, 4]] },
  { ec: 22, groups: [[38, 2], [39, 2]] },
  { ec: 22, groups: [[36, 3], [37, 2]] },
  { ec: 26, groups: [[43, 4], [44, 1]] },
]
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((d, i) => { result[i] ^= gfMul(d, factor) })
  }
  return result
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

function encodeData(bytes: Uint8Array): { version: number; codewords: number[] } {
  for (let v = 1; v <= BLOCKS.length; v++) {
    const spec = BLOCKS[v - 1]
    const capacity = spec.groups.reduce((s, [n, c]) => s + n * c, 0)
    const countBits = v < 10 ? 8 : 16
    if (4 + countBits + bytes.length * 8 > capacity * 8) continue
    const bits: number[] = []
    const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
    push(0b0100, 4)
    push(bytes.length, countBits)
    bytes.forEach((b) => push(b, 8))
    push(0, Math.min(4, capacity * 8 - bits.length))
    while (bits.length % 8) bits.push(0)
    const data: number[] = []
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
    for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad)
    // split into blocks, add Reed–Solomon EC, interleave
    const divisor = rsDivisor(spec.ec)
    const blocks: { data: number[]; ec: number[] }[] = []
    let k = 0
    for (const [n, count] of spec.groups) {
      for (let c = 0; c < count; c++) {
        const d = data.slice(k, k + n)
        k += n
        blocks.push({ data: d, ec: rsRemainder(d, divisor) })
      }
    }
    const out: number[] = []
    const maxData = Math.max(...blocks.map((b) => b.data.length))
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
    for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.ec[i])
    return { version: v, codewords: out }
  }
  throw new Error('Text is too long for a QR code (max 213 bytes)')
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function penalty(m: boolean[][]): number {
  const n = m.length
  let score = 0
  const runs = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let len = 1
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) len++
        else { if (len >= 5) score += 3 + (len - 5); len = 1 }
      }
      for (let j = 0; j + 10 < n + 1; j++) { // 1:1:3:1:1 finder-like pattern with 4 light modules on one side
        const seq = Array.from({ length: 11 }, (_, t) => (j + t < n ? get(i, j + t) : false))
        const p = [true, false, true, true, true, false, true]
        const a = p.every((v, t) => seq[t] === v) && seq.slice(7, 11).every((v) => !v)
        const b = seq.slice(0, 4).every((v) => !v) && p.every((v, t) => seq[t + 4] === v)
        if (a || b) score += 40
      }
    }
  }
  runs((i, j) => m[i][j])
  runs((i, j) => m[j][i])
  let dark = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++
      if (y + 1 < n && x + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
}

export function qrMatrix(text: string): boolean[][] {
  const { version, codewords } = encodeData(new TextEncoder().encode(text))
  const size = version * 4 + 17
  const mod = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => { mod[y][x] = dark; fn[y][x] = true }

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
      }
    }
  }
  const al = ALIGN[version - 1]
  al.forEach((ay, i) => al.forEach((ax, j) => {
    const last = al.length - 1
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const drawFormat = (mask: number) => {
    const data = (0 << 3) | mask // level M = 00
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i))
    set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i))
    set(8, size - 8, true)
  }
  drawFormat(0)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3)
      set(a, b, bit(bits, i)); set(b, a, bit(bits, i))
    }
  }
  // zig-zag data placement
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!fn[y][x] && i < codewords.length * 8) {
          mod[y][x] = bit(codewords[i >>> 3], 7 - (i & 7))
          i++
        }
      }
    }
  }
  // choose the mask with the lowest penalty
  let best: boolean[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask)
    const m = mod.map((row, y) => row.map((v, x) => (fn[y][x] ? v : v !== MASKS[mask](x, y))))
    const s = penalty(m)
    if (s < bestScore) { bestScore = s; best = m }
  }
  return best!
}

/** SVG path data ("M x y h1 v1 h-1z" per dark module) with a 4-module quiet zone. */
export function qrPath(text: string): { path: string; size: number } {
  const m = qrMatrix(text)
  const q = 4
  let d = ''
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + q} ${y + q}h1v1h-1z` }))
  return { path: d, size: m.length + q * 2 }
}
