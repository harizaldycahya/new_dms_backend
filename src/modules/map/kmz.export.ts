import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import JSZip from 'jszip'
import { pool, ScopeError, parseTargets, resolveScope, type Scope } from './kmz.scope.js'
import type { PointStyle } from './kmz.parser.js'
import { buildWorkbook, type ExportFeature } from './sheet.parser.js'

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void

/* ---------------- KML helpers (sama dengan export Project di kmz.routes.ts) ---------------- */

const xmlEsc = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  )

type Coords = [number, number]
const coordStr = (c: Coords) => `${c[0]},${c[1]},0`

function styleXml(st: PointStyle | null): string {
  if (!st) return ''
  const c = /^[0-9a-f]{6}$/.test(st.color) ? st.color : 'ffffff'
  const color = `ff${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}`
  const icon =
    st.icon !== 'custom' && /^[A-Za-z0-9_/-]+$/.test(st.icon)
      ? `<Icon><href>http://maps.google.com/mapfiles/kml/${st.icon}.png</href></Icon>`
      : ''
  return `<Style><IconStyle><color>${color}</color><scale>${Number(st.scale) || 1}</scale>${icon}</IconStyle></Style>`
}

function placemark(name: string | null, geomType: string, g: unknown, st: PointStyle | null = null): string {
  const nm = name ? `<name>${xmlEsc(name)}</name>` : ''
  if (geomType === 'Point') {
    return `<Placemark>${nm}${styleXml(st)}<Point><coordinates>${coordStr(g as Coords)}</coordinates></Point></Placemark>`
  }
  if (geomType === 'LineString') {
    return `<Placemark>${nm}<LineString><coordinates>${(g as Coords[]).map(coordStr).join(' ')}</coordinates></LineString></Placemark>`
  }
  const rings = g as Coords[][]
  const ring = (r: Coords[]) => `<LinearRing><coordinates>${r.map(coordStr).join(' ')}</coordinates></LinearRing>`
  const inner = rings.slice(1).map((r) => `<innerBoundaryIs>${ring(r)}</innerBoundaryIs>`).join('')
  return `<Placemark>${nm}<Polygon><outerBoundaryIs>${ring(rings[0])}</outerBoundaryIs>${inner}</Polygon></Placemark>`
}

type CatNode = { items: string[]; kids: Map<string, CatNode> }
const newNode = (): CatNode => ({ items: [], kids: new Map() })

function renderNode(n: CatNode): string {
  let out = n.items.join('')
  for (const [name, k] of n.kids) out += `<Folder><name>${xmlEsc(name)}</name>${renderNode(k)}</Folder>`
  return out
}

type FeatRow = {
  section_pk: string
  name: string | null
  category: string | null
  geom_type: string
  style: PointStyle | null
  coordinates: unknown
}

/**
 * POST /map/export
 * body: { targets: [{ level: 'project'|'segment'|'section', pk }], format?: 'kmz'|'xlsx' }
 * Semua target harus berada di satu Project.
 */
export function registerMapExport(router: Router, canEdit: RequestHandler, wrap: Wrap) {
  router.post(
    '/map/export',
    canEdit,
    wrap(async (req, res) => {
      let scope: Scope
      try {
        scope = await resolveScope(pool, parseTargets(req.body?.targets))
      } catch (e) {
        if (e instanceof ScopeError) return res.status(e.status).json({ message: e.message })
        throw e
      }

      const format = String(req.body?.format ?? 'kmz').toLowerCase() === 'xlsx' ? 'xlsx' : 'kmz'
      const sectionPks = scope.sections.map((s) => s.pk)

      let feats: FeatRow[] = []
      if (sectionPks.length > 0) {
        const r = await pool.query(
          `SELECT f.section_pk::text AS section_pk, f.name, f.category, f.geom_type, f.style,
                  ST_AsGeoJSON(f.geom, 7)::json -> 'coordinates' AS coordinates
             FROM map_features f
            WHERE f.section_pk = ANY($1::bigint[]) AND f.replaced_at IS NULL
            ORDER BY f.section_pk, f.seq, f.pk`,
          [sectionPks],
        )
        feats = r.rows as FeatRow[]
      }

      const safe = scope.project.id.replace(/[^A-Za-z0-9._-]/g, '_')
      const base = scope.wholeProject ? safe : `${safe}_selection`

      if (format === 'xlsx') {
        const secInfo = new Map(scope.sections.map((s) => [s.pk, s]))
        const rowsOut: ExportFeature[] = feats.map((f) => ({
          segment_id: secInfo.get(f.section_pk)!.segment_id,
          section_id: secInfo.get(f.section_pk)!.id,
          name: f.name,
          category: f.category,
          geom_type: f.geom_type,
          coordinates: f.coordinates,
          style: f.style,
        }))
        const xlsx = await buildWorkbook(
          { id: scope.project.id, name: scope.project.name },
          scope.sections.map((s) => ({ segment_id: s.segment_id, segment_name: s.segment_name, section_id: s.id, name: s.name })),
          rowsOut,
        )
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`)
        return res.send(xlsx)
      }

      // KMZ: folder Project > Segment > Section, hanya Section yang dipilih
      const treeBySection = new Map<string, CatNode>()
      for (const f of feats) {
        const root = treeBySection.get(f.section_pk) ?? newNode()
        treeBySection.set(f.section_pk, root)
        let node = root
        if (f.category) {
          for (const part of String(f.category).split('/')) {
            let next = node.kids.get(part)
            if (!next) {
              next = newNode()
              node.kids.set(part, next)
            }
            node = next
          }
        }
        node.items.push(placemark(f.name, f.geom_type, f.coordinates, f.style))
      }

      const segments = new Map<string, { id: string; sections: string[] }>()
      for (const s of scope.sections) {
        const seg = segments.get(s.segment_pk) ?? { id: s.segment_id, sections: [] as string[] }
        segments.set(s.segment_pk, seg)
        const node = treeBySection.get(s.pk)
        seg.sections.push(`<Folder><name>${xmlEsc(s.id)}</name>${node ? renderNode(node) : ''}</Folder>`)
      }

      const hint =
        'Folder names are the IDs from the Master Cable. Do not rename or move the Project, Segment, and Section folders. ' +
        'Put points/lines/polygons inside the Section folders (subfolders are allowed). ' +
        'A Section with an empty folder leaves its existing data unchanged.' +
        (scope.wholeProject ? '' : ' This file contains only the selected part of the Project; other Sections are not changed when you upload it.')
      const body = [...segments.values()]
        .map((s) => `<Folder><name>${xmlEsc(s.id)}</name>${s.sections.join('')}</Folder>`)
        .join('')
      const kml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEsc(scope.project.id)}</name>` +
        `<Folder><name>${xmlEsc(scope.project.id)}</name><description>${xmlEsc(hint)}</description>${body}</Folder>` +
        `</Document></kml>`

      const zip = new JSZip()
      zip.file('doc.kml', kml)
      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

      res.setHeader('Content-Type', 'application/vnd.google-earth.kmz')
      res.setHeader('Content-Disposition', `attachment; filename="${base}.kmz"`)
      res.send(out)
    }),
  )
}