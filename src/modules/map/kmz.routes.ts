import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { randomBytes } from 'node:crypto'
import { pool } from '../../db.js'
import { requireAuth, requireRole, type AuthUser } from '../../middleware/auth.js'
import { hashFeatures, parseKmz, styleKey, type ParsedFeature, type ParsedKmz, type ParsedSection, type PointStyle } from './kmz.parser.js'
import { parseSheet } from './sheet.parser.js'
import { requireMenu } from '../../middleware/access.js'
import { removedSamples } from './kmz.diff.js'
import { registerPreviewGeometry } from './kmz.geometry.js'
import { registerDeleteMapData } from './kmz.delete.js'
import { registerMapSummary } from './kmz.summary.js'
import { registerMapExport } from './kmz.export.js'

export const mapRouter = Router()

mapRouter.use('/map', requireAuth)
const canEdit = requireMenu('master-assets')

for (const name of ['projectPk']) {
  mapRouter.param(name, (_req, res, next, value) => {
    if (/^\d{1,18}$/.test(String(value))) return next()
    res.status(404).json({ message: 'Project not found' })
  })
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

registerDeleteMapData(mapRouter, canEdit, wrap)
registerMapSummary(mapRouter, canEdit, wrap)
registerMapExport(mapRouter, canEdit, wrap)

const MAX_UPLOAD_MB = 100
const STAGE_TTL_MS = 15 * 60 * 1000

/* =====================================================================
   Pencocokan KMZ <-> Master Cable
   Kunci pencocokan: jalur ID  SegmentID/SectionID  di dalam Project terpilih.
   ===================================================================== */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } // eslint-disable-line @typescript-eslint/no-explicit-any

type Status = 'create' | 'update' | 'unchanged' | 'skipped' | 'error'

type Risk = 'none' | 'warn' | 'high'

type CategoryDiff = { name: string; old: number; new: number }

type SectionResult = {
  segment_id: string
  segment_name: string | null
  section_id: string
  section_pk: string | null
  segment_pk: string | null
  name: string
  status: Status
  message: string
  new_count: number
  old_count: number
  points: number
  lines: number
  polygons: number
  old_points: number
  old_lines: number
  old_polygons: number
  categories: string[]
  category_diff: CategoryDiff[]
  /** object-by-object comparison with the current data */
  kept: number // identical (same place, name, category and style)
  changed: number // same place, but name, category or style differ
  added: number // new place
  removed: number // the place is no longer in the file
  /** none = nothing is lost, warn = some current objects disappear, high = probably a mistake, needs an explicit acknowledgement */
  risk: Risk
  risk_reasons: string[]
  removed_samples: { name: string | null; category: string | null; geom_type: string }[]
}

type Impact = {
  sections_changed: number
  features_added: number
  features_removed: number
  features_changed: number
  features_kept: number
  high_risk_sections: number
  warn_sections: number
}

type Classified = {
  rows: SectionResult[]
  notInFile: { segment_id: string; section_id: string; name: string }[]
  summary: Record<Status, number> & { not_in_file: number }
  impact: Impact
}

type OldFeature = { name: string | null; category: string | null; geomType: string; coordinates: unknown; style: string }

const featureKey = (f: { name: string | null; category: string | null; geomType: string; coordinates: unknown; style?: string }) =>
  JSON.stringify([f.name ?? '', f.category ?? '', f.geomType, f.coordinates, f.style ?? ''])

// bounding box of any GeoJSON coordinates
function bboxOf(coords: unknown, box: [number, number, number, number] = [180, 90, -180, -90]) {
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    const [x, y] = coords as number[]
    box[0] = Math.min(box[0], x)
    box[1] = Math.min(box[1], y)
    box[2] = Math.max(box[2], x)
    box[3] = Math.max(box[3], y)
  } else if (Array.isArray(coords)) {
    for (const c of coords) bboxOf(c, box)
  }
  return box
}

function distanceKm(a: [number, number, number, number], b: [number, number, number, number]) {
  const ca = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2]
  const cb = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(cb[1] - ca[1])
  const dLon = rad(cb[0] - ca[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(ca[1])) * Math.cos(rad(cb[1])) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const FAR_KM = 100
const BIG_SECTION = 10 // below this many current objects a drop is not treated as high risk

function assess(old: OldFeature[], neu: ParsedFeature[]) {
  // 1) identical objects are "kept"
  const left = new Map<string, number>()
  for (const f of old) {
    const k = featureKey(f)
    left.set(k, (left.get(k) ?? 0) + 1)
  }
  let kept = 0
  const newLeft: ParsedFeature[] = []
  for (const f of neu) {
    const k = featureKey({ name: f.name, category: f.category, geomType: f.geomType, coordinates: f.geometry.coordinates, style: styleKey(f.style) })
    const n = left.get(k) ?? 0
    if (n > 0) {
      kept++
      left.set(k, n - 1)
    } else newLeft.push(f)
  }
  const oldLeft: OldFeature[] = []
  for (const f of old) {
    const k = featureKey(f)
    const n = left.get(k) ?? 0
    if (n > 0) {
      oldLeft.push(f)
      left.set(k, n - 1)
    }
  }

  // 2) same place but another name/category/style = "changed" (not a removal)
  const place = (g: string, c: unknown) => JSON.stringify([g, c])
  const placeLeft = new Map<string, number>()
  for (const f of oldLeft) {
    const k = place(f.geomType, f.coordinates)
    placeLeft.set(k, (placeLeft.get(k) ?? 0) + 1)
  }
  let changed = 0
  for (const f of newLeft) {
    const k = place(f.geomType, f.geometry.coordinates)
    const n = placeLeft.get(k) ?? 0
    if (n > 0) {
      changed++
      placeLeft.set(k, n - 1)
    }
  }
  const removed = oldLeft.length - changed
  const added = newLeft.length - changed

  const reasons: string[] = []
  let risk: Risk = 'none'
  if (removed > 0) {
    risk = 'warn'
    reasons.push(`${removed} of the ${old.length} current objects are not in the file and will be removed`)
  }
  const oldLines = old.filter((f) => f.geomType === 'LineString').length
  const newLines = neu.filter((f) => f.geomType === 'LineString').length
  if (oldLines > 0 && newLines === 0) {
    risk = 'high'
    reasons.push(`The file has no lines, but the Section currently has ${oldLines}`)
  }
  if (old.length >= BIG_SECTION && removed > old.length / 2) {
    risk = 'high'
    reasons.push(`More than half of the current objects (${removed} of ${old.length}) will be removed`)
  }
  if (old.length > 0 && neu.length > 0) {
    const d = distanceKm(bboxOf(old.map((f) => f.coordinates)), bboxOf(neu.map((f) => f.geometry.coordinates)))
    if (d > FAR_KM) {
      risk = 'high'
      reasons.push(`The new data is about ${Math.round(d)} km away from the current data. Check the Section ID and the coordinates (latitude/longitude may be swapped)`)
    }
  }
  return { kept, changed, added, removed, risk, reasons }
}

function categoryDiff(old: OldFeature[], neu: ParsedFeature[]): CategoryDiff[] {
  const m = new Map<string, CategoryDiff>()
  const get = (name: string) => {
    let d = m.get(name)
    if (!d) m.set(name, (d = { name, old: 0, new: 0 }))
    return d
  }
  for (const f of old) get(f.category ?? '').old++
  for (const f of neu) get(f.category ?? '').new++
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function classify(db: Db, projectPk: string, parsed: ParsedKmz): Promise<Classified> {
  const { rows: master } = await db.query(
    `SELECT x.pk, x.segment_pk, s.segment_id, s.name AS segment_name, x.section_id, x.name
       FROM sections x
       JOIN segments s ON s.pk = x.segment_pk
      WHERE s.project_pk = $1 AND s.deleted_at IS NULL AND x.deleted_at IS NULL`,
    [projectPk],
  )

  const byKey = new Map<string, typeof master>()
  for (const m of master) {
    const k = `${m.segment_id}/${m.section_id}`.toLowerCase()
    byKey.set(k, [...(byKey.get(k) ?? []), m])
  }

  // Section yang ada di file dan dikenal di Master Cable
  const matched = new Map<string, (typeof master)[number]>()
  for (const s of parsed.sections) {
    const hit = byKey.get(`${s.segmentId}/${s.sectionId}`.toLowerCase())
    if (hit && hit.length === 1) matched.set(`${s.segmentId}/${s.sectionId}`.toLowerCase(), hit[0])
  }

  // fitur aktif yang sudah ada, hanya untuk Section yang ada di file
  const pks = [...matched.values()].map((m) => m.pk)
  const existing = new Map<string, OldFeature[]>()
  if (pks.length > 0) {
    const { rows } = await db.query(
      `SELECT section_pk, name, category, geom_type, style,
              ST_AsGeoJSON(geom, 7)::json -> 'coordinates' AS coordinates
         FROM map_features
        WHERE section_pk = ANY($1::bigint[]) AND replaced_at IS NULL`,
      [pks],
    )
    for (const r of rows) {
      const list = existing.get(r.section_pk) ?? []
      list.push({
        name: r.name,
        category: r.category,
        geomType: r.geom_type,
        coordinates: r.coordinates,
        style: styleKey(r.style as PointStyle | null),
      })
      existing.set(r.section_pk, list)
    }
  }

  const rows: SectionResult[] = parsed.sections.map((s: ParsedSection) => {
    const key = `${s.segmentId}/${s.sectionId}`.toLowerCase()
    const hits = byKey.get(key) ?? []
    const m = hits.length === 1 ? hits[0] : null
    const old = m ? existing.get(m.pk) ?? [] : []
    const a = old.length > 0 && s.features.length > 0 ? assess(old, s.features) : null

    const base = {
      segment_id: s.segmentId,
      segment_name: m ? (m.segment_name as string) : null,
      section_id: s.sectionId,
      // the folder only carries the ID, so the name always comes from the Master Cable
      name: m ? (m.name as string) : s.sectionName,
      new_count: s.features.length,
      points: s.features.filter((f) => f.geomType === 'Point').length,
      lines: s.features.filter((f) => f.geomType === 'LineString').length,
      polygons: s.features.filter((f) => f.geomType === 'Polygon').length,
      old_points: old.filter((f) => f.geomType === 'Point').length,
      old_lines: old.filter((f) => f.geomType === 'LineString').length,
      old_polygons: old.filter((f) => f.geomType === 'Polygon').length,
      categories: [...new Set(s.features.map((f) => f.category).filter((c): c is string => !!c))],
      category_diff: categoryDiff(old, s.features),
      kept: a?.kept ?? 0,
      changed: a?.changed ?? 0,
      added: a ? a.added : s.features.length,
      removed: a?.removed ?? 0,
      risk: (a?.risk ?? 'none') as Risk,
      risk_reasons: a?.reasons ?? [],
      removed_samples: a && a.removed > 0 ? removedSamples(old, s.features) : [],
    }
    if (hits.length === 0) {
      return { ...base, section_pk: null, segment_pk: null, old_count: 0, status: 'error', message: 'Not in the Master Cable. Add it in the Master Cable first or fix the ID' }
    }
    if (hits.length > 1) {
      return { ...base, section_pk: null, segment_pk: null, old_count: 0, status: 'error', message: 'This ID is ambiguous in the Master Cable (differs only by letter case)' }
    }
    if (s.features.length === 0) {
      return { ...base, section_pk: m!.pk, segment_pk: m!.segment_pk, old_count: old.length, status: 'skipped', message: 'No objects for this Section in the file, existing data is left untouched' }
    }
    if (old.length === 0) {
      return { ...base, section_pk: m!.pk, segment_pk: m!.segment_pk, old_count: 0, status: 'create', message: 'Section has no map data yet' }
    }
    const same = hashFeatures(old) === s.hash
    return {
      ...base,
      section_pk: m!.pk, segment_pk: m!.segment_pk,
      old_count: old.length,
      status: same ? 'unchanged' : 'update',
      message: same ? 'Same as the current data' : 'Current data is replaced (history is kept)',
    }
  })

  const inFile = new Set(parsed.sections.map((s) => `${s.segmentId}/${s.sectionId}`.toLowerCase()))
  const notInFile = master
    .filter((m) => !inFile.has(`${m.segment_id}/${m.section_id}`.toLowerCase()))
    .map((m) => ({ segment_id: m.segment_id, section_id: m.section_id, name: m.name }))

  const summary = { create: 0, update: 0, unchanged: 0, skipped: 0, error: 0, not_in_file: notInFile.length }
  for (const r of rows) summary[r.status]++

  const writes = rows.filter((r) => r.status === 'create' || r.status === 'update')
  const impact: Impact = {
    sections_changed: writes.length,
    features_added: writes.reduce((n, r) => n + r.added, 0),
    features_removed: writes.reduce((n, r) => n + r.removed, 0),
    features_changed: writes.reduce((n, r) => n + r.changed, 0),
    features_kept: writes.reduce((n, r) => n + r.kept, 0),
    high_risk_sections: writes.filter((r) => r.risk === 'high').length,
    warn_sections: writes.filter((r) => r.risk === 'warn').length,
  }
  return { rows, notInFile, summary, impact }
}

/* =====================================================================
   Staging preview di memori server (tanpa upload dua kali)
   ===================================================================== */

type Staged = {
  userId: AuthUser['id']
  projectPk: string
  filename: string
  size: number
  parsed: ParsedKmz
  expires: number
}

const FORMATS = /\.(kmz|kml|xlsx|csv)$/i

const staged = new Map<string, Staged>()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of staged) if (v.expires < now) staged.delete(k)
}, 60_000).unref()

registerPreviewGeometry(mapRouter, canEdit, wrap, (t) => staged.get(t))

/* =====================================================================
   Upload: preview (parse + cocokkan, belum menyimpan)
   ===================================================================== */

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
}).single('file')

const receive = (req: Request, res: Response, next: NextFunction) =>
  uploader(req, res, (err: unknown) => {
    if (!err) return next()
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `File is larger than ${MAX_UPLOAD_MB} MB` })
    }
    res.status(400).json({ message: 'Could not read the upload' })
  })

mapRouter.post(
  '/map/upload/preview',
  canEdit,
  receive,
  wrap(async (req, res) => {
    const file = req.file
    if (!file) return res.status(400).json({ message: 'No file selected' })
    // multer membaca nama file sebagai latin1
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8')
    if (!FORMATS.test(filename)) {
      return res.status(400).json({ message: 'File must be .kmz, .kml, .xlsx or .csv' })
    }
    const format = (/\.(kmz|kml|xlsx|csv)$/i.exec(filename)![1]).toLowerCase() as 'kmz' | 'kml' | 'xlsx' | 'csv'

    // Project ditentukan dari isi file: folder paling atas (KMZ) atau kolom project_id (Excel/CSV)
    let parsed: ParsedKmz
    try {
      parsed = format === 'xlsx' || format === 'csv' ? await parseSheet(file.buffer, format) : await parseKmz(file.buffer, filename)
    } catch (e) {
      return res.status(400).json({ message: e instanceof Error ? e.message : 'The file could not be read' })
    }

    const empty = { create: 0, update: 0, unchanged: 0, skipped: 0, error: 0, not_in_file: 0 }
    const noImpact: Impact = { sections_changed: 0, features_added: 0, features_removed: 0, features_changed: 0, features_kept: 0, high_risk_sections: 0, warn_sections: 0 }
    const reject = (errors: string[]) =>
      res.json({
        token: null,
        filename,
        format,
        project: null,
        can_confirm: false,
        ack_required: false,
        summary: empty,
        impact: noImpact,
        sections: [],
        not_in_file: [],
        errors,
        warnings: parsed.warnings.slice(0, 200),
        expires_in_sec: 0,
      })

    if (parsed.errors.length > 0 && !parsed.projectId) return reject(parsed.errors)

    const { rows: pr } = await pool.query(
      `SELECT pk, project_id, name FROM projects
        WHERE lower(project_id) = lower($1) AND deleted_at IS NULL`,
      [parsed.projectId],
    )
    if (!pr[0]) {
      return reject([
        ...parsed.errors,
        `Project "${parsed.projectId}" does not exist in the Master Cable. Create it there first or fix the Project ID in the file`,
      ])
    }
    const projectPk = String(pr[0].pk)

    const cls = await classify(pool, projectPk, parsed)

    // satu preview aktif per user
    for (const [k, v] of staged) if (v.userId === req.user!.id) staged.delete(k)
    const token = randomBytes(16).toString('hex')
    staged.set(token, {
      userId: req.user!.id,
      projectPk,
      filename,
      size: file.size,
      parsed,
      expires: Date.now() + STAGE_TTL_MS,
    })

    const blocked = parsed.errors.length > 0 || cls.summary.error > 0
    res.json({
      token,
      filename,
      format,
      project: { pk: projectPk, id: pr[0].project_id, name: pr[0].name },
      can_confirm: !blocked && cls.summary.create + cls.summary.update > 0,
      // true when at least one Section looks like a mistake: the user must tick an acknowledgement before saving
      ack_required: !blocked && cls.impact.high_risk_sections > 0,
      summary: cls.summary,
      impact: cls.impact,
      sections: cls.rows,
      not_in_file: cls.notInFile,
      errors: parsed.errors,
      warnings: parsed.warnings.slice(0, 200),
      expires_in_sec: STAGE_TTL_MS / 1000,
    })
  }),
)

/* =====================================================================
   Konfirmasi: simpan semuanya dalam satu transaksi
   ===================================================================== */

mapRouter.post(
  '/map/upload/confirm',
  canEdit,
  wrap(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : ''
    const st = staged.get(token)
    if (!st || st.expires < Date.now() || st.userId !== req.user!.id) {
      return res.status(410).json({ message: 'The preview has expired. Please upload the file again' })
    }
    const projectPk = st.projectPk

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // satu upload per Project dalam satu waktu
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [projectPk])

      // cocokkan ulang di dalam transaksi, kalau Master Cable / peta berubah sejak preview
      const cls = await classify(client, projectPk, st.parsed)
      if (st.parsed.errors.length > 0 || cls.summary.error > 0) {
        await client.query('ROLLBACK')
        return res.status(409).json({ message: 'The Master Cable changed since the preview. Please upload the file again' })
      }

      if (cls.impact.high_risk_sections > 0 && req.body?.ack !== true) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          code: 'ACK_REQUIRED',
          message: 'Some Sections need your acknowledgement before they can be saved. Review the highlighted Sections and confirm again',
        })
      }

      const { rows: up } = await client.query(
        `INSERT INTO kmz_uploads (project_pk, filename, size_bytes, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING pk`,
        [projectPk, st.filename, st.size, req.user!.id],
      )
      const uploadPk = up[0].pk as string

      let added = 0
      let replaced = 0
      const bySection = new Map(st.parsed.sections.map((s) => [`${s.segmentId}/${s.sectionId}`.toLowerCase(), s]))

      for (const r of cls.rows) {
        if (r.status !== 'create' && r.status !== 'update') continue
        const sec = bySection.get(`${r.segment_id}/${r.section_id}`.toLowerCase())!

        if (r.status === 'update') {
          const { rowCount } = await client.query(
            `UPDATE map_features SET replaced_at = now(), replaced_by_upload = $2
              WHERE section_pk = $1 AND replaced_at IS NULL`,
            [r.section_pk, uploadPk],
          )
          replaced += rowCount ?? 0
        }

        const payload = sec.features.map((f) => ({
          name: f.name,
          category: f.category,
          geom_type: f.geomType,
          geometry: f.geometry,
          seq: f.seq,
          style: f.style,
        }))
        await client.query(
          `INSERT INTO map_features (section_pk, upload_pk, name, category, geom_type, geom, seq, style)
           SELECT $1, $2, x.name, x.category, x.geom_type,
                  ST_SetSRID(ST_GeomFromGeoJSON(x.geometry::text), 4326), x.seq, x.style
             FROM jsonb_to_recordset($3::jsonb)
                  AS x(name text, category text, geom_type text, geometry jsonb, seq int, style jsonb)`,
          [r.section_pk, uploadPk, JSON.stringify(payload)],
        )
        added += payload.length
      }

      const summary = { ...cls.summary, features_added: added, features_replaced: replaced }
      await client.query('UPDATE kmz_uploads SET summary = $2::jsonb WHERE pk = $1', [uploadPk, JSON.stringify(summary)])
      await client.query('COMMIT')

      staged.delete(token)
      res.json({ ok: true, upload_pk: uploadPk, summary })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      client.release()
    }
  }),
)

/* ---------- Riwayat upload ---------- */
mapRouter.get(
  '/map/projects/:projectPk/uploads',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.pk, u.filename, u.size_bytes, u.uploaded_at, u.summary, usr.username AS uploaded_by
         FROM kmz_uploads u LEFT JOIN users usr ON usr.id = u.uploaded_by
        WHERE u.project_pk = $1
        ORDER BY u.uploaded_at DESC
        LIMIT 50`,
      [req.params.projectPk],
    )
    res.json({ items: rows })
  }),
)

/* =====================================================================
   Fitur peta untuk ditampilkan (semua role yang sudah login boleh melihat)
   GET /map/features                -> semua Project
   GET /map/features?project_pk=12  -> satu Project
   ===================================================================== */
mapRouter.get(
  '/map/features',
  wrap(async (req, res) => {
    const raw = req.query.project_pk
    const projectPk = typeof raw === 'string' && /^\d{1,18}$/.test(raw) ? raw : null

    const { rows } = await pool.query(
      `SELECT COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', f.pk,
                'geometry', ST_AsGeoJSON(f.geom, 7)::json,
                'properties', json_build_object(
                  'name', f.name,
                  'category', f.category,
                  'geom_type', f.geom_type,
                  'route', r.name,
                  'project_pk', p.pk::text,   'project_id', p.project_id,   'project_name', p.name,
                  'segment_pk', s.pk::text,   'segment_id', s.segment_id,   'segment_name', s.name,
                  'section_pk', x.pk::text,   'section_id', x.section_id,   'section_name', x.name
                )
              ) ORDER BY f.section_pk, f.seq), '[]'::json) AS features
         FROM map_features f
         JOIN sections x ON x.pk = f.section_pk AND x.deleted_at IS NULL
         JOIN segments s ON s.pk = x.segment_pk AND s.deleted_at IS NULL
         JOIN projects p ON p.pk = s.project_pk AND p.deleted_at IS NULL
         LEFT JOIN routes r ON r.route_id = x.route_id
        WHERE f.replaced_at IS NULL
          AND ($1::bigint IS NULL OR p.pk = $1::bigint)`,
      [projectPk],
    )
    res.json({ type: 'FeatureCollection', features: rows[0].features })
  }),
)

