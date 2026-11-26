import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

export const serpoSectionRouter = Router()

serpoSectionRouter.use('/serpo-section', requireAuth)
const canEdit = requireMenu('serpo-section', 'edit')

// semua item dialamatkan lewat pk numerik
for (const name of ['sectionPk', 'servicePointPk']) {
  serpoSectionRouter.param(name, (_req, res, next, value) => {
    if (/^\d{1,18}$/.test(String(value))) return next()
    res.status(404).json({ message: 'Item not found' })
  })
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pk = z.string().regex(/^\d{1,18}$/, 'Invalid pk')

/* ---------- Semua data untuk dua tab, satu request ----------
   service_points: Serpo aktif + jumlah Section yang dipegang.
                   Breadcrumb Area > Cluster dibangun di frontend dari /so/tree
                   (cluster_pk dikirim di sini sebagai kunci penghubung).
   sections:       Section aktif + path Project > Segment + serpo-nya (atau null) */
serpoSectionRouter.get(
  '/serpo-section',
  wrap(async (_req, res) => {
    const [servicePoints, sections] = await Promise.all([
      pool.query(
        `SELECT sp.pk, sp.service_point_id AS id, sp.name, sp.cluster_pk,
                (SELECT count(*)
                   FROM section_service_point m
                   JOIN sections x ON x.pk = m.section_pk AND x.deleted_at IS NULL
                  WHERE m.service_point_pk = sp.pk)::int AS section_count
         FROM so_service_points sp
         WHERE sp.deleted_at IS NULL
         ORDER BY sp.name`,
      ),
      pool.query(
        `SELECT x.pk, x.section_id AS id, x.name, x.route_id, r.name AS route_name,
                s.pk AS segment_pk, s.name AS segment_name,
                p.pk AS project_pk, p.name AS project_name,
                m.service_point_pk
         FROM sections x
         JOIN routes r ON r.route_id = x.route_id
         JOIN segments s ON s.pk = x.segment_pk
         JOIN projects p ON p.pk = s.project_pk
         LEFT JOIN section_service_point m
                ON m.section_pk = x.pk
               AND EXISTS (SELECT 1 FROM so_service_points sp
                            WHERE sp.pk = m.service_point_pk AND sp.deleted_at IS NULL)
         WHERE x.deleted_at IS NULL
         ORDER BY x.name`,
      ),
    ])
    res.json({ service_points: servicePoints.rows, sections: sections.rows })
  }),
)

/* ---------- Assign / pindah / lepas satu Section (dipakai tab "Per Section") ----------
   body { service_point_pk: string | null }
   null = lepas mapping. Memindahkan dari Serpo lain diperbolehkan
   (konfirmasi dilakukan di UI). */
serpoSectionRouter.put(
  '/serpo-section/sections/:sectionPk',
  canEdit,
  wrap(async (req, res) => {
    const b = z.object({ service_point_pk: pk.nullable() }).safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const sectionPk = req.params.sectionPk
    const target = b.data.service_point_pk

    const section = await pool.query(`SELECT 1 FROM sections WHERE pk = $1 AND deleted_at IS NULL`, [
      sectionPk,
    ])
    if (!section.rows[0]) return res.status(404).json({ message: 'Section not found' })

    if (target === null) {
      await pool.query(`DELETE FROM section_service_point WHERE section_pk = $1`, [sectionPk])
      return res.json({ section_pk: sectionPk, service_point_pk: null })
    }

    const sp = await pool.query(
      `SELECT 1 FROM so_service_points WHERE pk = $1 AND deleted_at IS NULL`,
      [target],
    )
    if (!sp.rows[0]) return res.status(404).json({ message: 'Service Point not found' })

    await pool.query(
      `INSERT INTO section_service_point (section_pk, service_point_pk, created_by, updated_by)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (section_pk) DO UPDATE
         SET service_point_pk = EXCLUDED.service_point_pk,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       WHERE section_service_point.service_point_pk IS DISTINCT FROM EXCLUDED.service_point_pk`,
      [sectionPk, target, req.user!.id],
    )
    res.json({ section_pk: sectionPk, service_point_pk: target })
  }),
)

/* ---------- Assign banyak Section ke satu Serpo (dipakai picker di "Per Serpo") ----------
   body { section_pks: string[] }. Yang sudah dipegang Serpo lain ikut dipindah. */
serpoSectionRouter.post(
  '/serpo-section/service-points/:servicePointPk/sections',
  canEdit,
  wrap(async (req, res) => {
    const b = z
      .object({ section_pks: z.array(pk).min(1, 'Select at least one Section').max(500) })
      .safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const spPk = req.params.servicePointPk
    const sectionPks = [...new Set(b.data.section_pks)]

    const sp = await pool.query(
      `SELECT 1 FROM so_service_points WHERE pk = $1 AND deleted_at IS NULL`,
      [spPk],
    )
    if (!sp.rows[0]) return res.status(404).json({ message: 'Service Point not found' })

    const { rows } = await pool.query(
      `INSERT INTO section_service_point (section_pk, service_point_pk, created_by, updated_by)
       SELECT x.pk, $1, $3, $3
       FROM sections x
       WHERE x.pk = ANY($2::bigint[]) AND x.deleted_at IS NULL
       ON CONFLICT (section_pk) DO UPDATE
         SET service_point_pk = EXCLUDED.service_point_pk,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       WHERE section_service_point.service_point_pk IS DISTINCT FROM EXCLUDED.service_point_pk
       RETURNING section_pk`,
      [spPk, sectionPks, req.user!.id],
    )
    res.json({ assigned: rows.length })
  }),
)

/* ---------- Lepas satu Section dari Serpo (tombol X di "Per Serpo") ---------- */
serpoSectionRouter.delete(
  '/serpo-section/sections/:sectionPk',
  canEdit,
  wrap(async (req, res) => {
    await pool.query(`DELETE FROM section_service_point WHERE section_pk = $1`, [req.params.sectionPk])
    res.json({ ok: true })
  }),
)