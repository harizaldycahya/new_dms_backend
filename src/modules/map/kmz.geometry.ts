import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { pool } from '../../db.js'
import { styleKey, type ParsedKmz, type PointStyle } from './kmz.parser.js'
import { bboxOf, diffFeatures, type FeatureState, type OldLike } from './kmz.diff.js'

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void

// the part of a staged preview that this endpoint needs
export type StagedLike = { userId: unknown; projectPk: string; expires: number; parsed: ParsedKmz }

// more than this and the response gets heavy; every change is always kept, the identical objects fill the rest
const MAX_SHOWN = 20_000

type Item = { state: FeatureState; geomType: string; coordinates: unknown; name: string | null; category: string | null }

/**
 * POST /map/upload/preview/geometry
 * body: { token, segment_id, section_id }
 * Returns one Section as GeoJSON, every object tagged with its state:
 * kept | changed | added | removed (see kmz.diff.ts), plus the bounding box and counts.
 */
export function registerPreviewGeometry(
  router: Router,
  canEdit: RequestHandler,
  wrap: Wrap,
  getStaged: (token: string) => StagedLike | undefined,
) {
  router.post(
    '/map/upload/preview/geometry',
    canEdit,
    wrap(async (req, res) => {
      const token = typeof req.body?.token === 'string' ? req.body.token : ''
      const st = getStaged(token)
      if (!st || st.expires < Date.now() || st.userId !== req.user!.id) {
        return res.status(410).json({ message: 'The preview has expired. Please upload the file again' })
      }

      const key = `${String(req.body?.segment_id ?? '').trim()}/${String(req.body?.section_id ?? '').trim()}`.toLowerCase()
      const sec = st.parsed.sections.find((s) => `${s.segmentId}/${s.sectionId}`.toLowerCase() === key)
      if (!sec) return res.status(404).json({ message: 'This Section is not in the file' })

      const { rows: m } = await pool.query(
        `SELECT x.pk
           FROM sections x
           JOIN segments s ON s.pk = x.segment_pk
          WHERE s.project_pk = $1 AND s.deleted_at IS NULL AND x.deleted_at IS NULL
            AND lower(s.segment_id) = lower($2) AND lower(x.section_id) = lower($3)`,
        [st.projectPk, sec.segmentId, sec.sectionId],
      )

      // unknown or ambiguous ID: there is no saved data to compare with, so only the file is shown
      const old: OldLike[] = []
      if (m.length === 1) {
        const { rows } = await pool.query(
          `SELECT name, category, geom_type, style,
                  ST_AsGeoJSON(geom, 7)::json -> 'coordinates' AS coordinates
             FROM map_features
            WHERE section_pk = $1 AND replaced_at IS NULL
            ORDER BY seq, pk`,
          [m[0].pk],
        )
        for (const r of rows) {
          old.push({
            name: r.name,
            category: r.category,
            geomType: r.geom_type,
            coordinates: r.coordinates,
            style: styleKey(r.style as PointStyle | null),
          })
        }
      }

      const { oldStates, newStates } = diffFeatures(old, sec.features)

      // kept and changed objects sit in the same place in both versions, so one copy (the file's) is enough
      const items: Item[] = sec.features.map((f, i) => ({
        state: newStates[i],
        geomType: f.geomType,
        coordinates: f.geometry.coordinates,
        name: f.name,
        category: f.category,
      }))
      old.forEach((f, i) => {
        if (oldStates[i] === 'removed') {
          items.push({ state: 'removed', geomType: f.geomType, coordinates: f.coordinates, name: f.name, category: f.category })
        }
      })

      const counts: Record<FeatureState, number> = { kept: 0, changed: 0, added: 0, removed: 0 }
      for (const it of items) counts[it.state]++

      let shown = items
      if (items.length > MAX_SHOWN) {
        const changes = items.filter((i) => i.state !== 'kept')
        const kept = items.filter((i) => i.state === 'kept')
        shown = [...changes.slice(0, MAX_SHOWN), ...kept.slice(0, Math.max(0, MAX_SHOWN - changes.length))]
      }

      const box = bboxOf(shown.map((i) => i.coordinates))
      res.json({
        type: 'FeatureCollection',
        features: shown.map((i) => ({
          type: 'Feature',
          geometry: { type: i.geomType, coordinates: i.coordinates },
          properties: { state: i.state, name: i.name, category: i.category },
        })),
        bbox: box[0] <= box[2] && box[1] <= box[3] ? box : null,
        counts,
        total: items.length,
        shown: shown.length,
        truncated: shown.length < items.length,
      })
    }),
  )
}