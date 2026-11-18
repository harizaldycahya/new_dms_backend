import ExcelJS from 'exceljs'
import {
  hashFeatures,
  styleKey,
  type GeoGeometry,
  type ParsedFeature,
  type ParsedKmz,
  type ParsedSection,
  type PointStyle,
} from './kmz.parser.js'

/* =====================================================================
   Excel (.xlsx) / CSV untuk DMS.

   Satu baris = satu titik. Garis dan poligon ditulis sebagai beberapa baris
   dengan feature_no yang sama; urutan titik sudut ditentukan oleh seq.

   Kolom (judul kolom tidak membedakan huruf besar/kecil):
     type        Point | Line | Polygon            (wajib)
     project_id  ID Project di Master Cable        (wajib)
     segment_id  ID Segment                        (wajib)
     section_id  ID Section                        (wajib)
     category    kategori / subfolder, mis. "Pole" atau "HH/Bekasi"
     name        nama objek
     feature_no  pengelompok baris untuk Line/Polygon (wajib untuk keduanya)
     seq         urutan titik sudut di dalam feature_no
     ring        Polygon saja: 0 = batas luar (default), 1.. = lubang
     lat, lon    derajat desimal                   (wajib)
     icon, color, scale   Point saja, opsional

   Hasilnya memakai struktur yang sama dengan KMZ (ParsedKmz), jadi preview,
   konfirmasi, hash, dan aturan Create/Update/Unchanged tidak berbeda.
   ===================================================================== */

const COORD_DECIMALS = 7
const MAX_ROWS = 500_000
const MAX_ERRORS = 50

export type ExportFeature = {
  segment_id: string
  section_id: string
  name: string | null
  category: string | null
  geom_type: string
  coordinates: unknown
  style: PointStyle | null
}

type Cell = string | number | null
type Row = { n: number; cells: Cell[] }

/* ---------------- membaca baris dari file ---------------- */

function normCell(v: unknown): Cell {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? null : t
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as { result?: unknown; richText?: { text?: string }[]; text?: unknown; error?: unknown }
    if ('result' in o) return normCell(o.result)
    if (Array.isArray(o.richText)) return normCell(o.richText.map((r) => r.text ?? '').join(''))
    if ('text' in o) return normCell(o.text)
    if ('error' in o) return String(o.error)
  }
  return String(v)
}

async function readXlsx(buf: Buffer): Promise<Row[]> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch {
    throw new Error('The file is not a valid Excel (.xlsx) file')
  }
  const ws = wb.getWorksheet('Data') ?? wb.worksheets[0]
  if (!ws) throw new Error('The Excel file has no sheets')
  if (ws.rowCount > MAX_ROWS + 1) throw new Error(`The sheet has more than ${MAX_ROWS.toLocaleString('en-US')} rows`)

  const width = ws.columnCount
  const rows: Row[] = []
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const cells: Cell[] = []
    for (let c = 1; c <= width; c++) cells.push(normCell(row.getCell(c).value))
    rows.push({ n, cells })
  })
  return rows
}

function readCsv(buf: Buffer): Row[] {
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  // pemisah: koma, titik koma (Excel versi Indonesia), atau tab, dilihat dari baris judul
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const count = (ch: string) => firstLine.split(ch).length - 1
  const delim = [',', ';', '\t'].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',')

  const rows: Row[] = []
  let cells: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let startLine = 1
  const endField = () => {
    cells.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    if (cells.some((c) => c.trim() !== '')) rows.push({ n: startLine, cells: cells.map((c) => normCell(c)) })
    cells = []
    startLine = line + 1
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else {
        if (ch === '\n') line++
        field += ch
      }
    } else if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delim) {
      endField()
    } else if (ch === '\n') {
      endRow()
      line++
    } else if (ch !== '\r') {
      field += ch
    }
    if (rows.length > MAX_ROWS + 1) throw new Error(`The file has more than ${MAX_ROWS.toLocaleString('en-US')} rows`)
  }
  if (field !== '' || cells.length > 0) endRow()
  return rows
}

/* ---------------- kolom ---------------- */

const ALIASES: Record<string, string[]> = {
  type: ['type', 'jenis', 'tipe'],
  project_id: ['projectid', 'project'],
  segment_id: ['segmentid', 'segment'],
  section_id: ['sectionid', 'section'],
  category: ['category', 'kategori', 'folder'],
  name: ['name', 'nama'],
  feature_no: ['featureno', 'feature', 'featureid', 'nomor', 'no'],
  seq: ['seq', 'sequence', 'urutan', 'order'],
  ring: ['ring'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
  icon: ['icon', 'ikon'],
  color: ['color', 'colour', 'warna'],
  scale: ['scale', 'skala'],
}
const REQUIRED = ['type', 'project_id', 'segment_id', 'section_id', 'lat', 'lon']

const keyOf = (s: string) => s.toLowerCase().replace(/[\s_\-.]/g, '')

function mapColumns(header: Cell[]): Map<string, number> {
  const cols = new Map<string, number>()
  header.forEach((h, i) => {
    if (h == null) return
    const k = keyOf(String(h))
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(k) && !cols.has(field)) cols.set(field, i)
    }
  })
  return cols
}

/* ---------------- nilai ---------------- */

const text = (v: Cell) => (v == null ? '' : String(v).trim())

function toNumber(v: Cell): number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  let t = v.replace(/\s/g, '')
  if (t.includes(',') && !t.includes('.')) t = t.replace(',', '.') // koma desimal (-6,2 -> -6.2)
  if (t === '' || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t)) return null
  return Number(t)
}

const round = (v: number) => Number(v.toFixed(COORD_DECIMALS))

function kindOf(v: string): 'Point' | 'LineString' | 'Polygon' | null {
  const t = v.toLowerCase().replace(/[\s_-]/g, '')
  if (['point', 'titik', 'p'].includes(t)) return 'Point'
  if (['line', 'linestring', 'garis', 'l'].includes(t)) return 'LineString'
  if (['polygon', 'poligon', 'area'].includes(t)) return 'Polygon'
  return null
}

const cleanCategory = (v: string) =>
  v
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/')

function styleFrom(icon: string, color: string, scale: number | null, warn: (m: string) => void, where: string): PointStyle | null {
  if (!icon && !color && scale == null) return null

  let key = icon.trim().toLowerCase()
  if (key && key !== 'custom' && !key.includes('/')) key = `shapes/${key}`
  if (key && !/^[a-z0-9_/-]+$/.test(key)) {
    warn(`${where}: icon "${icon}" is not valid, a circle is used`)
    key = ''
  }
  if (!key) key = 'shapes/shaded_dot'

  let hex = color.trim().replace(/^#/, '').toLowerCase()
  if (hex && !/^[0-9a-f]{6}$/.test(hex)) {
    warn(`${where}: color "${color}" must be 6 hex digits like ff0000, white is used`)
    hex = ''
  }
  if (!hex) hex = 'ffffff'

  const sc = scale != null ? Math.min(3, Math.max(0.3, Math.round(scale * 100) / 100)) : 1
  return { icon: key, color: hex, scale: sc }
}

/* ---------------- parser ---------------- */

type Vertex = { lon: number; lat: number; seq: number | null; row: number }
type Group = {
  segment: string
  section: string
  kind: 'LineString' | 'Polygon'
  label: string
  firstRow: number
  name: string | null
  category: string | null
  rings: Map<number, Vertex[]>
}

export async function parseSheet(buf: Buffer, format: 'xlsx' | 'csv'): Promise<ParsedKmz> {
  const errors: string[] = []
  const warnings: string[] = []
  const result: ParsedKmz = { projectId: '', projectName: '', sections: [], errors, warnings }
  let extraErrors = 0
  const fail = (m: string) => {
    if (errors.length < MAX_ERRORS) errors.push(m)
    else extraErrors++
  }
  const warn = (m: string) => {
    if (warnings.length < 200) warnings.push(m)
  }

  const rows = format === 'xlsx' ? await readXlsx(buf) : readCsv(buf)
  if (rows.length === 0) {
    fail('The file is empty')
    return result
  }

  const cols = mapColumns(rows[0].cells)
  const missing = REQUIRED.filter((c) => !cols.has(c))
  if (missing.length > 0) {
    fail(`Missing column(s): ${missing.join(', ')}. Use the template downloaded from DMS`)
    return result
  }
  const cell = (r: Row, field: string): Cell => {
    const i = cols.get(field)
    return i == null ? null : r.cells[i] ?? null
  }

  type SectionAcc = { segmentId: string; sectionId: string; features: ParsedFeature[] }
  const sections = new Map<string, SectionAcc>()
  const groups = new Map<string, Group>()
  const groupOrder: string[] = []
  const projects = new Map<string, string>() // lower -> as written

  const sectionOf = (segmentId: string, sectionId: string) => {
    const k = `${segmentId}/${sectionId}`.toLowerCase()
    let s = sections.get(k)
    if (!s) sections.set(k, (s = { segmentId, sectionId, features: [] }))
    return s
  }

  for (const r of rows.slice(1)) {
    const where = `Row ${r.n}`
    const typeRaw = text(cell(r, 'type'))
    const projectId = text(cell(r, 'project_id'))
    const segmentId = text(cell(r, 'segment_id'))
    const sectionId = text(cell(r, 'section_id'))
    const latRaw = cell(r, 'lat')
    const lonRaw = cell(r, 'lon')
    // a row without any of the required values is treated as an empty row
    if (!typeRaw && !projectId && !segmentId && !sectionId && latRaw == null && lonRaw == null) continue

    let bad = false
    const need = (v: string, label: string) => {
      if (!v) {
        fail(`${where}: ${label} is empty`)
        bad = true
      }
    }
    need(projectId, 'project_id')
    need(segmentId, 'segment_id')
    need(sectionId, 'section_id')
    const kind = kindOf(typeRaw)
    if (!kind) {
      fail(`${where}: type "${typeRaw}" must be Point, Line or Polygon`)
      bad = true
    }

    const lat = toNumber(latRaw)
    const lon = toNumber(lonRaw)
    if (lat == null || lon == null) {
      fail(`${where}: lat and lon must be numbers`)
      bad = true
    } else if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      const swapped = lon >= -90 && lon <= 90 && lat >= -180 && lat <= 180
      fail(`${where}: coordinates are out of range${swapped ? ' (latitude and longitude look swapped)' : ''}`)
      bad = true
    }
    if (bad || !kind || lat == null || lon == null) continue

    if (!projects.has(projectId.toLowerCase())) projects.set(projectId.toLowerCase(), projectId)

    const name = text(cell(r, 'name')) || null
    const category = cleanCategory(text(cell(r, 'category'))) || null
    const sec = sectionOf(segmentId, sectionId)
    const label = `${segmentId}/${sectionId}`

    if (kind === 'Point') {
      const scaleRaw = cell(r, 'scale')
      const scale = scaleRaw == null ? null : toNumber(scaleRaw)
      if (scaleRaw != null && scale == null) warn(`${where}: scale "${scaleRaw}" is not a number, 1 is used`)
      sec.features.push({
        seq: 0,
        name,
        category,
        geomType: 'Point',
        geometry: { type: 'Point', coordinates: [round(lon), round(lat)] },
        style: styleFrom(text(cell(r, 'icon')), text(cell(r, 'color')), scale, warn, where),
      })
      continue
    }

    // Line / Polygon: grouped by feature_no
    const featureNo = text(cell(r, 'feature_no'))
    if (!featureNo) {
      fail(`${where}: feature_no is required for a ${kind === 'LineString' ? 'Line' : 'Polygon'} (rows with the same number form one shape)`)
      continue
    }
    const gk = `${segmentId}/${sectionId}/${featureNo}`.toLowerCase()
    let g = groups.get(gk)
    if (!g) {
      g = { segment: segmentId, section: sectionId, kind, label: `${label} › feature ${featureNo}`, firstRow: r.n, name, category, rings: new Map() }
      groups.set(gk, g)
      groupOrder.push(gk)
    } else {
      if (g.kind !== kind) {
        fail(`${where}: feature ${featureNo} in ${label} mixes types (${g.kind === 'LineString' ? 'Line' : g.kind} and ${kind === 'LineString' ? 'Line' : kind})`)
        continue
      }
      if ((name ?? '') !== (g.name ?? '') || (category ?? '') !== (g.category ?? '')) {
        warn(`${where}: name/category differs from the first row of feature ${featureNo} in ${label}, the first row is used`)
      }
    }

    let ring = 0
    if (kind === 'Polygon') {
      const ringRaw = cell(r, 'ring')
      if (ringRaw != null) {
        const n = toNumber(ringRaw)
        if (n == null || !Number.isInteger(n) || n < 0) {
          fail(`${where}: ring must be 0 (outer boundary) or a positive whole number (hole)`)
          continue
        }
        ring = n
      }
    }
    const seqRaw = cell(r, 'seq')
    const seq = seqRaw == null ? null : toNumber(seqRaw)
    if (seqRaw != null && seq == null) {
      fail(`${where}: seq must be a number`)
      continue
    }
    const list = g.rings.get(ring) ?? []
    list.push({ lon: round(lon), lat: round(lat), seq, row: r.n })
    g.rings.set(ring, list)
  }

  // ---- merge the shapes into their Sections
  for (const gk of groupOrder) {
    const g = groups.get(gk)!
    const orderRing = (vs: Vertex[]) => {
      const bySeq = vs.every((v) => v.seq != null)
      return [...vs].sort((a, b) => (bySeq ? (a.seq as number) - (b.seq as number) : a.row - b.row))
    }
    const sec = sectionOf(g.segment, g.section)

    if (g.kind === 'LineString') {
      const pts = orderRing(g.rings.get(0) ?? []).map((v) => [v.lon, v.lat] as [number, number])
      if ((g.rings.get(0)?.length ?? 0) !== [...g.rings.values()].reduce((n, l) => n + l.length, 0)) {
        warn(`Row ${g.firstRow}: ring is ignored for a Line (${g.label})`)
      }
      if (pts.length < 2) {
        fail(`Row ${g.firstRow}: ${g.label} is a Line and needs at least 2 points`)
        continue
      }
      sec.features.push({ seq: 0, name: g.name, category: g.category, geomType: 'LineString', geometry: { type: 'LineString', coordinates: pts }, style: null })
      continue
    }

    const ringNos = [...g.rings.keys()].sort((a, b) => a - b)
    if (ringNos[0] !== 0) {
      fail(`Row ${g.firstRow}: ${g.label} is a Polygon without an outer boundary (ring 0)`)
      continue
    }
    const rings: [number, number][][] = []
    let ok = true
    for (const no of ringNos) {
      const pts = orderRing(g.rings.get(no)!).map((v) => [v.lon, v.lat] as [number, number])
      const first = pts[0]
      const last = pts[pts.length - 1]
      if (pts.length > 1 && first[0] === last[0] && first[1] === last[1]) pts.pop() // the closing point is added again below
      if (pts.length < 3) {
        fail(`Row ${g.firstRow}: ${g.label} ring ${no} needs at least 3 distinct points`)
        ok = false
        break
      }
      pts.push([pts[0][0], pts[0][1]])
      rings.push(pts)
    }
    if (!ok) continue
    const geometry: GeoGeometry = { type: 'Polygon', coordinates: rings }
    sec.features.push({ seq: 0, name: g.name, category: g.category, geomType: 'Polygon', geometry, style: null })
  }

  if (projects.size > 1) {
    fail(`The file contains more than one Project (${[...projects.values()].map((p) => `"${p}"`).join(', ')}). One file is for one Project only`)
  }
  result.projectId = projects.size > 0 ? [...projects.values()][0] : ''

  for (const s of sections.values()) {
    s.features.forEach((f, i) => (f.seq = i))
    const section: ParsedSection = {
      segmentId: s.segmentId,
      sectionId: s.sectionId,
      sectionName: s.sectionId,
      features: s.features,
      hash: hashFeatures(
        s.features.map((f) => ({
          name: f.name,
          category: f.category,
          geomType: f.geomType,
          coordinates: f.geometry.coordinates,
          style: styleKey(f.style),
        })),
      ),
    }
    result.sections.push(section)
  }

  if (extraErrors > 0) errors.push(`...and ${extraErrors} more error${extraErrors === 1 ? '' : 's'}`)
  if (result.sections.length === 0 && errors.length === 0) errors.push('No data rows found in the file')
  return result
}

/* =====================================================================
   Template / ekspor Excel
   ===================================================================== */

const COLUMNS: { key: string; header: string; width: number }[] = [
  { key: 'type', header: 'type', width: 10 },
  { key: 'project_id', header: 'project_id', width: 16 },
  { key: 'segment_id', header: 'segment_id', width: 16 },
  { key: 'section_id', header: 'section_id', width: 16 },
  { key: 'category', header: 'category', width: 18 },
  { key: 'name', header: 'name', width: 28 },
  { key: 'feature_no', header: 'feature_no', width: 12 },
  { key: 'seq', header: 'seq', width: 8 },
  { key: 'ring', header: 'ring', width: 8 },
  { key: 'lat', header: 'lat', width: 14 },
  { key: 'lon', header: 'lon', width: 14 },
  { key: 'icon', header: 'icon', width: 12 },
  { key: 'color', header: 'color', width: 10 },
  { key: 'scale', header: 'scale', width: 8 },
]

export async function buildWorkbook(
  project: { id: string; name: string },
  sections: { segment_id: string; segment_name: string; section_id: string; name: string }[],
  features: ExportFeature[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'DMS'

  /* ---- Data ---- */
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = COLUMNS.map((c) => ({ key: c.key, header: c.header, width: c.width }))
  const head = ws.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A2342' } }
  ws.getColumn('lat').numFmt = '0.0000000'
  ws.getColumn('lon').numFmt = '0.0000000'
  ws.getColumn('color').numFmt = '@' // keep "0000ff" as text

  const shapeNo = new Map<string, number>() // per Section counter for feature_no
  const nextNo = (k: string) => {
    const n = (shapeNo.get(k) ?? 0) + 1
    shapeNo.set(k, n)
    return n
  }
  const icon = (s: PointStyle | null) => (s ? (s.icon.startsWith('shapes/') ? s.icon.slice(7) : s.icon) : '')

  for (const f of features) {
    const base = { project_id: project.id, segment_id: f.segment_id, section_id: f.section_id, category: f.category ?? '', name: f.name ?? '' }
    if (f.geom_type === 'Point') {
      const [lon, lat] = f.coordinates as [number, number]
      ws.addRow({
        type: 'Point', ...base, lat, lon,
        icon: icon(f.style), color: f.style?.color ?? '', scale: f.style && f.style.scale !== 1 ? f.style.scale : '',
      })
    } else if (f.geom_type === 'LineString') {
      const no = nextNo(`${f.segment_id}/${f.section_id}`)
      ;(f.coordinates as [number, number][]).forEach(([lon, lat], i) => {
        ws.addRow({ type: 'Line', ...base, feature_no: no, seq: i + 1, lat, lon })
      })
    } else {
      const no = nextNo(`${f.segment_id}/${f.section_id}`)
      ;(f.coordinates as [number, number][][]).forEach((ring, ri) => {
        ring.slice(0, -1).forEach(([lon, lat], i) => {
          ws.addRow({ type: 'Polygon', ...base, feature_no: no, seq: i + 1, ring: ri, lat, lon })
        })
      })
    }
  }
  // dropdown for the type column (exceljs supports this at runtime, but its typings do not declare it)
  ;(ws as unknown as { dataValidations: { add: (range: string, v: unknown) => void } }).dataValidations.add('A2:A100000', {
    type: 'list',
    allowBlank: true,
    formulae: ['"Point,Line,Polygon"'],
  })

  /* ---- Sections (valid IDs) ---- */
  const wsS = wb.addWorksheet('Sections', { views: [{ state: 'frozen', ySplit: 1 }] })
  wsS.columns = [
    { header: 'project_id', key: 'p', width: 16 },
    { header: 'segment_id', key: 'sg', width: 16 },
    { header: 'segment name', key: 'sgn', width: 34 },
    { header: 'section_id', key: 's', width: 16 },
    { header: 'section name', key: 'sn', width: 34 },
  ]
  const hs = wsS.getRow(1)
  hs.font = { bold: true }
  hs.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  for (const s of sections) wsS.addRow({ p: project.id, sg: s.segment_id, sgn: s.segment_name, s: s.section_id, sn: s.name })

  /* ---- Guide ---- */
  const wsG = wb.addWorksheet('Guide')
  wsG.getColumn(1).width = 110
  const lines = [
    `Project: ${project.id} (${project.name})`,
    '',
    'HOW TO FILL THE "Data" SHEET',
    '- One row is one point. A line or a polygon is written as several rows with the same feature_no; seq gives the order of its points.',
    '- type: Point, Line or Polygon.',
    '- project_id, segment_id, section_id must match the Master Cable exactly (see the "Sections" sheet).',
    '- category is optional. Use / for sub-levels, for example HH/Bekasi.',
    '- lat and lon are decimal degrees (lat -90 to 90, lon -180 to 180). Do not swap them.',
    '- feature_no is required for Line and Polygon. Rows with the same feature_no in the same Section form one shape.',
    '- ring is only for Polygon: 0 (or empty) is the outer boundary, 1 and above are holes.',
    '- icon, color and scale are optional and only for Point. icon: circle, square, donut, target, forbidden, triangle, diamond, star, cross. color: 6 hex digits such as ff0000.',
    '',
    'BEFORE YOU UPLOAD',
    '- Uploading REPLACES the whole content of every Section that appears in the file. Keep every object you want to keep.',
    '- A Section that does not appear in the file is not changed.',
    '- DMS shows exactly what will change before anything is saved.',
  ]
  lines.forEach((t, i) => {
    const row = wsG.addRow([t])
    if (i === 0 || t === 'HOW TO FILL THE "Data" SHEET' || t === 'BEFORE YOU UPLOAD') row.font = { bold: true }
    row.alignment = { wrapText: true, vertical: 'top' }
  })

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out as ArrayBuffer)
}