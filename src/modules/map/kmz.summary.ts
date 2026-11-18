import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { pool } from '../../db.js'

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void

/**
 * GET /map/summary
 * Satu baris per Section yang punya data peta aktif: jumlah objek per tipe
 * dan upload terakhir (kapan, oleh siapa). Section tanpa data tidak muncul.
 * Roll-up ke Segment dan Project dilakukan di frontend.
 */
export function registerMapSummary(router: Router, canEdit: RequestHandler, wrap: Wrap) {
  router.get(
    '/map/summary',
    canEdit,
    wrap(async (_req, res) => {
      const { rows } = await pool.query(
        `SELECT f.section_pk::text AS section_pk,
                count(*) FILTER (WHERE f.geom_type = 'Point')::int      AS points,
                count(*) FILTER (WHERE f.geom_type = 'LineString')::int AS lines,
                count(*) FILTER (WHERE f.geom_type = 'Polygon')::int    AS polygons,
                (array_agg(f.upload_pk::text ORDER BY u.uploaded_at DESC NULLS LAST))[1] AS upload_pk
           FROM map_features f
           JOIN sections x ON x.pk = f.section_pk AND x.deleted_at IS NULL
           JOIN segments s ON s.pk = x.segment_pk AND s.deleted_at IS NULL
           JOIN projects p ON p.pk = s.project_pk AND p.deleted_at IS NULL
           LEFT JOIN kmz_uploads u ON u.pk = f.upload_pk
          WHERE f.replaced_at IS NULL
          GROUP BY f.section_pk`,
      )

      const uploadPks = [...new Set(rows.map((r) => r.upload_pk as string | null).filter((v): v is string => !!v))]
      const uploads = new Map<string, { at: string; by: string | null }>()
      if (uploadPks.length > 0) {
        const { rows: ups } = await pool.query(
          `SELECT u.pk::text AS pk, u.uploaded_at, usr.username AS uploaded_by
             FROM kmz_uploads u
             LEFT JOIN users usr ON usr.id = u.uploaded_by
            WHERE u.pk = ANY($1::bigint[])`,
          [uploadPks],
        )
        for (const u of ups) uploads.set(u.pk, { at: new Date(u.uploaded_at).toISOString(), by: u.uploaded_by ?? null })
      }

      res.json({
        sections: rows.map((r) => {
          const up = r.upload_pk ? uploads.get(r.upload_pk) : undefined
          return {
            section_pk: r.section_pk as string,
            points: r.points as number,
            lines: r.lines as number,
            polygons: r.polygons as number,
            last_upload_at: up?.at ?? null,
            last_upload_by: up?.by ?? null,
          }
        }),
      })
    }),
  )
}