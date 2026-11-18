import { Router, type NextFunction, type Request, type Response } from 'express'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'

/* =====================================================================
   Data peta untuk ditampilkan (semua user yang sudah login boleh melihat)
     GET /map/tree                    -> isi panel layer + versi data
     GET /map/tiles/:z/:x/:y.pbf      -> vector tile (PostGIS ST_AsMVT)
   ===================================================================== */

export const mapDataRouter = Router()
mapDataRouter.use('/map', requireAuth)

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

/* ---------- panel layer: hanya Section yang punya data peta ---------- */
mapDataRouter.get(
  '/map/tree',
  wrap(async (_req, res) => {
    const { rows: secs } = await pool.query(
      `SELECT x.pk, x.section_id, x.name,
              x.segment_pk, s.segment_id, s.name AS segment_name, x.route_id,
              s.project_pk, p.project_id, p.name AS project_name,
              count(*) FILTER (WHERE f.geom_type = 'Point')::int      AS points,
              count(*) FILTER (WHERE f.geom_type = 'LineString')::int AS lines,
              count(*) FILTER (WHERE f.geom_type = 'Polygon')::int    AS polygons,
              ST_XMin(ST_Extent(f.geom)) AS xmin, ST_YMin(ST_Extent(f.geom)) AS ymin,
              ST_XMax(ST_Extent(f.geom)) AS xmax, ST_YMax(ST_Extent(f.geom)) AS ymax
         FROM map_features f
         JOIN sections x ON x.pk = f.section_pk AND x.deleted_at IS NULL
         JOIN segments s ON s.pk = x.segment_pk AND s.deleted_at IS NULL
         JOIN projects p ON p.pk = s.project_pk AND p.deleted_at IS NULL
        WHERE f.replaced_at IS NULL
        GROUP BY x.pk, s.pk, p.pk
        ORDER BY p.project_id, s.segment_id, x.section_id`,
    )

    const { rows: cats } = await pool.query(
      `SELECT f.section_pk, coalesce(f.category, '') AS category, count(*)::int AS n,
              mode() WITHIN GROUP (ORDER BY (f.style->>'icon') || ':' || (f.style->>'color'))
                FILTER (WHERE f.style IS NOT NULL) AS icon
         FROM map_features f
        WHERE f.replaced_at IS NULL
        GROUP BY f.section_pk, coalesce(f.category, '')
        ORDER BY 1, 2`,
    )
    const catsBySection = new Map<string, { name: string; count: number; icon: string | null }[]>()
    for (const c of cats) {
      const list = catsBySection.get(c.section_pk) ?? []
      list.push({ name: c.category, count: c.n, icon: c.icon ?? null })
      catsBySection.set(c.section_pk, list)
    }

    const { rows: ver } = await pool.query(
      `SELECT coalesce(extract(epoch FROM max(uploaded_at))::bigint, 0)::text AS v FROM kmz_uploads`,
    )

    const projects = new Map<string, { pk: string; id: string; name: string }>()
    const segments = new Map<string, { pk: string; id: string; name: string; project_pk: string; route_id: number }>()
    for (const r of secs) {
      projects.set(r.project_pk, { pk: r.project_pk, id: r.project_id, name: r.project_name })
      // route_id now lives on the Section; a Segment takes the route of its first Section (only used for the dot color)
      if (segments.has(r.segment_pk)) continue
      segments.set(r.segment_pk, {
        pk: r.segment_pk,
        id: r.segment_id,
        name: r.segment_name,
        project_pk: r.project_pk,
        route_id: r.route_id,
      })
    }

    res.json({
      version: ver[0].v,
      projects: [...projects.values()],
      segments: [...segments.values()],
      sections: secs.map((r) => ({
        pk: r.pk,
        id: r.section_id,
        name: r.name,
        segment_pk: r.segment_pk,
        points: r.points,
        lines: r.lines,
        polygons: r.polygons,
        bbox: r.xmin == null ? null : [r.xmin, r.ymin, r.xmax, r.ymax],
        categories: catsBySection.get(r.pk) ?? [],
      })),
    })
  }),
)

/* ---------- vector tile ---------- */
const TILE_SQL = `
  WITH env AS (SELECT ST_TileEnvelope($1::int, $2::int, $3::int) AS g)
  SELECT ST_AsMVT(t, 'features', 4096, 'geom', 'id') AS tile
    FROM (
      SELECT f.pk::bigint        AS id,
             f.section_pk::bigint AS section_pk,
             x.segment_pk::bigint AS segment_pk,
             s.project_pk::bigint AS project_pk,
             x.route_id::int      AS route_id,
             f.name, f.category, f.geom_type,
             CASE WHEN f.style IS NOT NULL THEN (f.style->>'icon') || ':' || (f.style->>'color') END AS icon,
             (f.style->>'scale')::float8 AS iscale,
             f.section_pk::text || ':' || coalesce(f.category, '') AS ck,
             ST_AsMVTGeom(ST_Transform(f.geom, 3857), env.g, 4096, 64, true) AS geom
        FROM map_features f
        JOIN sections x ON x.pk = f.section_pk AND x.deleted_at IS NULL
        JOIN segments s ON s.pk = x.segment_pk AND s.deleted_at IS NULL
        JOIN projects p ON p.pk = s.project_pk AND p.deleted_at IS NULL
        CROSS JOIN env
       WHERE f.replaced_at IS NULL
         AND f.geom && ST_Transform(env.g, 4326)
    ) t
   WHERE t.geom IS NOT NULL`

mapDataRouter.get(
  '/map/tiles/:z/:x/:yfile',
  wrap(async (req, res) => {
    const z = Number(req.params.z)
    const x = Number(req.params.x)
    const m = /^(\d{1,8})\.pbf$/.exec(String(req.params.yfile))
    const y = m ? Number(m[1]) : NaN
    const n = 2 ** z
    if (!Number.isInteger(z) || z < 0 || z > 22 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
      return res.status(400).json({ message: 'Invalid tile' })
    }
    const { rows } = await pool.query(TILE_SQL, [z, x, y])
    const tile: Buffer = rows[0]?.tile ?? Buffer.alloc(0)
    res.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile')
    // the client adds ?v=<data version>, so a new upload gets fresh tiles
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(tile)
  }),
)