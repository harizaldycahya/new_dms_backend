import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { createHash } from 'node:crypto'

/* =====================================================================
   KMZ parser untuk DMS.

   Struktur folder yang diharapkan (sama dengan template yang diunduh dari DMS):

     Project   "ID"
       Segment   "ID"
         Section   "ID"                        <- unit terkecil
     (format lama "ID | Nama" tetap diterima; hanya ID yang dipakai)
             Placemark (titik/garis/poligon)   langsung di folder Section
             Subfolder bebas (mis. "Pole")     -> menjadi `category`

   Fungsi ini murni (tanpa database). Pencocokan dengan Master Cable dan
   penyimpanan dilakukan di kmz.routes.ts.
   ===================================================================== */

export type GeoGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }

/** Gaya ikon titik dari KML (IconStyle). icon = nama ikon standar Google Earth, mis. "shapes/forbidden". */
export type PointStyle = { icon: string; color: string; scale: number } // color = "rrggbb"

export const styleKey = (s: PointStyle | null | undefined) => (s ? `${s.icon}|${s.color}|${s.scale}` : '')

export type ParsedFeature = {
  seq: number
  name: string | null
  category: string | null // jalur subfolder di dalam folder Section, mis. "Pole" atau "HH/Bekasi"
  geomType: 'Point' | 'LineString' | 'Polygon'
  geometry: GeoGeometry
  style: PointStyle | null // hanya untuk titik
}

export type ParsedSection = {
  segmentId: string
  sectionId: string
  sectionName: string
  features: ParsedFeature[]
  /** hash isi Section; sama = tidak ada perubahan */
  hash: string
}

export type ParsedKmz = {
  projectId: string
  projectName: string
  sections: ParsedSection[]
  /** masalah yang membuat upload harus ditolak */
  errors: string[]
  /** hal yang diabaikan tetapi tidak fatal */
  warnings: string[]
}

export const MAX_KML_CHARS = 120_000_000 // batas setelah di-unzip (anti zip-bomb)
const COORD_DECIMALS = 7 // ~1 cm; dipakai juga saat membandingkan dengan isi DB

/* ---------------- util DOM ---------------- */

type El = {
  localName?: string | null
  nodeName: string
  nodeType: number
  childNodes: ArrayLike<El>
  textContent: string | null
  getAttribute?: (name: string) => string | null
}

const isEl = (n: El) => n.nodeType === 1
const lname = (n: El) => (n.localName ?? n.nodeName.split(':').pop() ?? '').toLowerCase()
const kids = (n: El): El[] => Array.from(n.childNodes).filter(isEl)
const child = (n: El, name: string) => kids(n).find((c) => lname(c) === name)
const childText = (n: El, name: string) => (child(n, name)?.textContent ?? '').trim()

/** Nama folder = ID saja (mis. "SEC-1"). Format lama "ID | Nama" tetap diterima. */
export function splitFolderName(raw: string): { id: string; name: string } | null {
  const i = raw.indexOf('|')
  const id = (i < 0 ? raw : raw.slice(0, i)).trim()
  const name = i < 0 ? '' : raw.slice(i + 1).trim()
  if (!id || id.length > 100) return null
  return { id, name: name || id }
}

/* ---------------- gaya ikon ---------------- */

const kmlColorToHex = (c: string) => {
  const t = c.trim().toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(t)) return 'ffffff'
  return t.slice(6, 8) + t.slice(4, 6) + t.slice(2, 4) // aabbggrr -> rrggbb
}

/** Ambil gaya ikon dari elemen <Style>. Ikon Google Earth dikenali dari URL mapfiles/kml/<nama>.png */
function iconStyleOf(style: El | undefined): PointStyle | null {
  const ic = style && child(style, 'iconstyle')
  if (!ic) return null
  const href = (() => {
    const icon = child(ic, 'icon')
    return icon ? childText(icon, 'href') : ''
  })()
  const m = /mapfiles\/kml\/([A-Za-z0-9_/-]+)\.png/i.exec(href)
  const scale = Number.parseFloat(childText(ic, 'scale'))
  return {
    icon: m ? m[1].toLowerCase() : 'custom',
    color: kmlColorToHex(childText(ic, 'color')),
    scale: Number.isFinite(scale) ? Math.min(3, Math.max(0.3, Math.round(scale * 100) / 100)) : 1,
  }
}

/** Kumpulkan <Style> dan <StyleMap> (pasangan "normal") dari seluruh dokumen. */
function collectStyles(root: El) {
  const styles = new Map<string, El>()
  const maps = new Map<string, string>()
  const visit = (n: El) => {
    for (const k of kids(n)) {
      const t = lname(k)
      const id = k.getAttribute?.('id') ?? ''
      if (t === 'style' && id) styles.set(id, k)
      else if (t === 'stylemap' && id) {
        for (const pair of kids(k).filter((x) => lname(x) === 'pair')) {
          if (childText(pair, 'key') === 'normal') maps.set(id, childText(pair, 'styleurl').replace(/^#/, ''))
        }
      }
      if (t === 'document' || t === 'folder') visit(k)
    }
  }
  visit(root)
  return (placemark: El): PointStyle | null => {
    const inline = child(placemark, 'style')
    if (inline) return iconStyleOf(inline)
    let ref = childText(placemark, 'styleurl')
    if (!ref.startsWith('#')) return null
    ref = ref.slice(1)
    ref = maps.get(ref) ?? ref
    return iconStyleOf(styles.get(ref))
  }
}

/* ---------------- geometri ---------------- */

const round = (v: number) => Number(v.toFixed(COORD_DECIMALS))

function parseCoords(text: string): [number, number][] | null {
  const out: [number, number][] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue
    const p = tok.split(',')
    const lon = Number(p[0])
    const lat = Number(p[1])
    if (p.length < 2 || !Number.isFinite(lon) || !Number.isFinite(lat)) return null
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
    out.push([round(lon), round(lat)]) // altitude dibuang
  }
  return out
}

function ringOf(el: El | undefined): [number, number][] | null {
  if (!el) return null
  const lr = child(el, 'linearring')
  const c = lr && child(lr, 'coordinates')
  if (!c) return null
  const pts = parseCoords(c.textContent ?? '')
  if (!pts || pts.length < 3) return null
  const [a, b] = [pts[0], pts[pts.length - 1]]
  if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]) // tutup ring
  return pts.length >= 4 ? pts : null
}

/** Satu Placemark bisa berisi beberapa geometri (MultiGeometry) -> beberapa fitur. */
function geometriesOf(node: El, warn: (m: string) => void, label: string): GeoGeometry[] {
  const out: GeoGeometry[] = []
  for (const g of kids(node)) {
    const t = lname(g)
    if (t === 'point') {
      const c = child(g, 'coordinates')
      const pts = c && parseCoords(c.textContent ?? '')
      if (pts && pts.length === 1) out.push({ type: 'Point', coordinates: pts[0] })
      else warn(`${label}: invalid Point coordinates, skipped`)
    } else if (t === 'linestring') {
      const c = child(g, 'coordinates')
      const pts = c && parseCoords(c.textContent ?? '')
      if (pts && pts.length >= 2) out.push({ type: 'LineString', coordinates: pts })
      else warn(`${label}: invalid LineString (needs at least 2 points), skipped`)
    } else if (t === 'polygon') {
      const outer = ringOf(child(g, 'outerboundaryis'))
      if (!outer) {
        warn(`${label}: invalid Polygon, skipped`)
        continue
      }
      const holes = kids(g)
        .filter((k) => lname(k) === 'innerboundaryis')
        .map((k) => ringOf(k))
        .filter((r): r is [number, number][] => !!r)
      out.push({ type: 'Polygon', coordinates: [outer, ...holes] })
    } else if (t === 'multigeometry') {
      out.push(...geometriesOf(g, warn, label))
    } else if (t === 'track' || t === 'multitrack') {
      warn(`${label}: gx:Track is not supported, skipped`)
    }
  }
  return out
}

/* ---------------- hash ---------------- */

export type HashItem = {
  name: string | null
  category: string | null
  geomType: string
  coordinates: unknown
  style?: string // styleKey()
}

/** Tidak peduli urutan fitur, supaya export lalu upload ulang tetap terbaca "tidak berubah". */
export function hashFeatures(items: HashItem[]) {
  const canon = items
    .map((f) => JSON.stringify([f.name ?? '', f.category ?? '', f.geomType, f.coordinates, f.style ?? '']))
    .sort()
  return createHash('sha256').update(canon.join('\n')).digest('hex')
}

function hashSection(features: ParsedFeature[]) {
  return hashFeatures(
    features.map((f) => ({
      name: f.name,
      category: f.category,
      geomType: f.geomType,
      coordinates: f.geometry.coordinates,
      style: styleKey(f.style),
    })),
  )
}

/* ---------------- parser utama ---------------- */

export async function readKml(buf: Buffer, filename: string): Promise<string> {
  if (/\.kml$/i.test(filename)) {
    const s = buf.toString('utf8')
    if (s.length > MAX_KML_CHARS) throw new Error('The KML file is too large')
    return s
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw new Error('The file is not a valid KMZ/ZIP')
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.kml$/i.test(f.name))
  const entry = entries.find((f) => /(^|\/)doc\.kml$/i.test(f.name)) ?? entries[0]
  if (!entry) throw new Error('No .kml file found inside the KMZ')
  const s = await entry.async('string')
  if (s.length > MAX_KML_CHARS) throw new Error('The KMZ is too large once extracted')
  return s
}

export function parseKml(xml: string, expectedProjectId?: string): ParsedKmz {
  const errors: string[] = []
  const warnings: string[] = []
  const result: ParsedKmz = { projectId: '', projectName: '', sections: [], errors, warnings }

  let fatal = ''
  let doc: { documentElement: El | null } = { documentElement: null }
  try {
    doc = new DOMParser({
      onError: (level: string, msg: string) => {
        if (level !== 'warning' && !fatal) fatal = msg
      },
    }).parseFromString(xml, 'text/xml') as unknown as { documentElement: El | null }
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'parse error'
  }
  if (fatal || !doc.documentElement) {
    errors.push('The KML file is corrupted or is not valid XML')
    return result
  }

  // turun melewati <kml> dan <Document> sampai menemukan folder-folder paling atas
  let top = doc.documentElement
  for (let guard = 0; guard < 5; guard++) {
    const fs = kids(top).filter((k) => lname(k) === 'folder')
    const ds = kids(top).filter((k) => lname(k) === 'document')
    if (fs.length === 0 && ds.length === 1) top = ds[0]
    else break
  }

  const projectFolders = kids(top).filter((k) => lname(k) === 'folder')
  if (projectFolders.length === 0) {
    errors.push('The KMZ contains no folders. Use the template downloaded from DMS')
    return result
  }
  if (kids(top).some((k) => lname(k) === 'placemark')) {
    warnings.push('Placemarks outside the Project folder are ignored')
  }

  if (!expectedProjectId && projectFolders.length > 1) {
    const ids = projectFolders.map((f) => `"${childText(f, 'name')}"`).join(', ')
    errors.push(`The KMZ contains more than one Project folder (${ids}). One file is for one Project only`)
    return result
  }

  const styleOf = collectStyles(doc.documentElement)
  const seenSections = new Set<string>()
  let matchedProject = false

  for (const pf of projectFolders) {
    const pn = splitFolderName(childText(pf, 'name'))
    if (!pn) {
      errors.push(`Folder Project "${childText(pf, 'name')}" has no ID (the folder name must be its ID)`)
      continue
    }
    if (expectedProjectId && pn.id.toLowerCase() !== expectedProjectId.toLowerCase()) {
      errors.push(`Folder Project "${pn.id}" does not match the selected Project "${expectedProjectId}"`)
      continue
    }
    if (matchedProject) {
      errors.push(`Folder Project "${pn.id}" appears more than once`)
      continue
    }
    matchedProject = true
    result.projectId = pn.id
    result.projectName = pn.name

    if (kids(pf).some((k) => lname(k) === 'placemark')) {
      warnings.push('Placemarks directly inside the Project folder are ignored')
    }

    for (const sf of kids(pf).filter((k) => lname(k) === 'folder')) {
      const sn = splitFolderName(childText(sf, 'name'))
      if (!sn) {
        errors.push(`Folder Segment "${childText(sf, 'name')}" has no ID (the folder name must be its ID)`)
        continue
      }
      if (kids(sf).some((k) => lname(k) === 'placemark')) {
        warnings.push(`Placemarks directly inside Segment "${sn.id}" are ignored`)
      }

      for (const cf of kids(sf).filter((k) => lname(k) === 'folder')) {
        const cn = splitFolderName(childText(cf, 'name'))
        if (!cn) {
          errors.push(`Folder Section "${childText(cf, 'name')}" (Segment ${sn.id}) has no ID (the folder name must be its ID)`)
          continue
        }
        const key = `${sn.id}/${cn.id}`.toLowerCase()
        if (seenSections.has(key)) {
          errors.push(`Section ${sn.id}/${cn.id} appears more than once`)
          continue
        }
        seenSections.add(key)

        const features: ParsedFeature[] = []
        const label = `${sn.id}/${cn.id}`
        const warn = (m: string) => warnings.push(m)

        // semua isi folder Section (termasuk subfolder) dirender apa adanya
        const walk = (node: El, path: string[]) => {
          for (const k of kids(node)) {
            const t = lname(k)
            if (t === 'folder') {
              const fname = childText(k, 'name') || 'Folder'
              walk(k, [...path, fname])
            } else if (t === 'placemark') {
              const name = childText(k, 'name') || null
              const geoms = geometriesOf(k, warn, `${label} › ${name ?? '(unnamed)'}`)
              for (const g of geoms) {
                features.push({
                  seq: features.length,
                  name,
                  category: path.length ? path.join('/') : null,
                  geomType: g.type,
                  geometry: g,
                  style: g.type === 'Point' ? styleOf(k) : null,
                })
              }
            }
          }
        }
        walk(cf, [])

        result.sections.push({
          segmentId: sn.id,
          sectionId: cn.id,
          sectionName: cn.name,
          features,
          hash: hashSection(features),
        })
      }
    }
  }

  if (!matchedProject && errors.length === 0) {
    errors.push(`Folder Project "${expectedProjectId ?? ''}" was not found in the KMZ`)
  }
  if (result.sections.length === 0 && errors.length === 0) {
    errors.push('No Section folders found in the KMZ')
  }
  return result
}

export async function parseKmz(buf: Buffer, filename: string, expectedProjectId?: string): Promise<ParsedKmz> {
  const xml = await readKml(buf, filename)
  return parseKml(xml, expectedProjectId)
}