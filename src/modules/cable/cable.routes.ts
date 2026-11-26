import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'
import { runCoreSync, SyncError } from '../core/cores.routes.js'

export const cableRouter = Router()

cableRouter.use('/cable', requireAuth)
const canEdit = requireMenu('master-cable', 'edit')

// every item is addressed by its numeric pk, because an ID may repeat under different parent s
for (const name of ['pk', 'projectPk', 'segmentPk', 'sectionPk']) {
  cableRouter.param(name, (_req, res, next, value) => {
    if (/^\d{1,18}$/.test(String(value))) return next()
    res.status(404).json({ message: 'Item not found' })
  })
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const baseBody = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'ID is required')
    .max(50, 'ID must be at most 50 characters')
    .regex(/^[A-Za-z0-9._-]+$/, 'ID may only contain letters, numbers, dots, hyphens, and underscores'),
  name: z.string().trim().min(1, 'Name is required').max(150, 'Name must be at most 150 characters'),
})
// the route now belongs to the Section (not the Segment)
const sectionBody = baseBody.extend({
  route: z.enum(['Submarine', 'Inland', 'Lastmile'], { message: 'Route is required' }),
})

const pgCode = (e: unknown) => (e as { code?: string }).code

type Key = 'projects' | 'segments' | 'sections'

const DUPLICATE: Record<Key, string> = {
  projects: 'This ID is already used by another Project',
  segments: 'This ID is already used by another Segment in the same Project',
  sections: 'This ID is already used by another Section in the same Segment',
}

async function insert(res: Response, key: Key, sql: string, params: unknown[]) {
  try {
    const { rows } = await pool.query(sql, params)
    if (!rows[0]) return res.status(404).json({ message: 'Parent item not found' })
    res.status(201).json(rows[0])
  } catch (e) {
    if (pgCode(e) === '23505') return res.status(409).json({ message: DUPLICATE[key] })
    throw e
  }
}

/* =====================  LIST + ADD  =====================
   Relations use the numeric pk. The ID typed by the user only has to be
   unique among the active items of the same parent (Project: globally). */

/* ---------- Project ---------- */
cableRouter.get(
  '/cable/projects',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT p.pk, p.project_id AS id, p.name,
              (SELECT count(*) FROM segments s
                WHERE s.project_pk = p.pk AND s.deleted_at IS NULL)::int AS child_count
       FROM projects p
       WHERE p.deleted_at IS NULL
       ORDER BY p.name`,
    )
    res.json({ items: rows })
  }),
)

cableRouter.post(
  '/cable/projects',
  canEdit,
  wrap(async (req, res) => {
    const b = baseBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    await insert(
      res,
      'projects',
      `INSERT INTO projects (project_id, name, created_by) VALUES ($1, $2, $3)
       RETURNING pk, project_id AS id, name, 0 AS child_count`,
      [b.data.id, b.data.name, req.user!.id],
    )
  }),
)

/* ---------- Segment (child of Project) - no route anymore ---------- */
cableRouter.get(
  '/cable/projects/:projectPk/segments',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT s.pk, s.segment_id AS id, s.name,
              (SELECT count(*) FROM sections x
                WHERE x.segment_pk = s.pk AND x.deleted_at IS NULL)::int AS child_count
       FROM segments s
       WHERE s.project_pk = $1 AND s.deleted_at IS NULL
       ORDER BY s.name`,
      [req.params.projectPk],
    )
    res.json({ items: rows })
  }),
)

cableRouter.post(
  '/cable/projects/:projectPk/segments',
  canEdit,
  wrap(async (req, res) => {
    const b = baseBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    await insert(
      res,
      'segments',
      `INSERT INTO segments (segment_id, project_pk, name, created_by)
       SELECT $1, p.pk, $3, $4 FROM projects p
       WHERE p.pk = $2 AND p.deleted_at IS NULL
       RETURNING pk, segment_id AS id, name, 0 AS child_count`,
      [b.data.id, req.params.projectPk, b.data.name, req.user!.id],
    )
  }),
)

/* ---------- Section (child of Segment) - route lives on the section ---------- */
cableRouter.get(
  '/cable/segments/:segmentPk/sections',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT x.pk, x.section_id AS id, x.name, x.route_id, r.name AS route_name,
              0 AS child_count
       FROM sections x
       JOIN routes r ON r.route_id = x.route_id
       WHERE x.segment_pk = $1 AND x.deleted_at IS NULL
       ORDER BY x.name`,
      [req.params.segmentPk],
    )
    res.json({ items: rows })
  }),
)

cableRouter.post(
  '/cable/segments/:segmentPk/sections',
  canEdit,
  wrap(async (req, res) => {
    const b = sectionBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    // route_id comes from the routes master (Submarine 1, Inland 2, Lastmile 3)
    await insert(
      res,
      'sections',
      `INSERT INTO sections (section_id, segment_pk, route_id, name, created_by)
       SELECT $1, s.pk, r.route_id, $4, $5
       FROM segments s, routes r
       WHERE s.pk = $2 AND s.deleted_at IS NULL AND r.name = $3
       RETURNING pk, section_id AS id, name, route_id, $3::text AS route_name, 0 AS child_count`,
      [b.data.id, req.params.segmentPk, b.data.route, b.data.name, req.user!.id],
    )
  }),
)

/* ---------- Whole tree in one request (used by "Expand all") ---------- */
cableRouter.get(
  '/cable/tree',
  wrap(async (_req, res) => {
    const [segments, sections] = await Promise.all([
      pool.query(
        `SELECT s.pk, s.segment_id AS id, s.name,
                s.project_pk AS parent_pk,
                (SELECT count(*) FROM sections x
                  WHERE x.segment_pk = s.pk AND x.deleted_at IS NULL)::int AS child_count
         FROM segments s
         WHERE s.deleted_at IS NULL
         ORDER BY s.name`,
      ),
      pool.query(
        `SELECT x.pk, x.section_id AS id, x.name, x.route_id, r.name AS route_name,
                x.segment_pk AS parent_pk, 0 AS child_count
         FROM sections x
         JOIN routes r ON r.route_id = x.route_id
         WHERE x.deleted_at IS NULL
         ORDER BY x.name`,
      ),
    ])
    res.json({ segments: segments.rows, sections: sections.rows })
  }),
)

/* ---------- Combined sync: parent first, then core ---------- */
cableRouter.post(
  '/cable/sync',
  canEdit,
  wrap(async (_req, res) => {
    // 1) parent sync (Project/Segment/Section) goes HERE, and must be
    //    committed before core runs, because core is matched through
    //    project_id -> segment_id -> section_id + route_id.
    //    (not available yet: no parent sync code exists)

    // 2) core sync
    try {
      const cores = await runCoreSync()
      res.json({ cores })
    } catch (e) {
      if (e instanceof SyncError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  }),
)

/* =====================  EDIT + DELETE (SOFT DELETE)  ===================== */

const LEVELS: Record<Key, { table: string; idCol: string; hasRoute: boolean }> = {
  projects: { table: 'projects', idCol: 'project_id', hasRoute: false },
  segments: { table: 'segments', idCol: 'segment_id', hasRoute: false },
  sections: { table: 'sections', idCol: 'section_id', hasRoute: true },
}

const SOFT = 'deleted_at = now(), deleted_by = $2'

// $1 = pk of the deleted item, $2 = user id. Order: deepest level first.
const CASCADE: Record<Key, string[]> = {
  projects: [
    `UPDATE sections SET ${SOFT} WHERE deleted_at IS NULL AND segment_pk IN (
       SELECT pk FROM segments WHERE project_pk = $1)`,
    `UPDATE segments SET ${SOFT} WHERE deleted_at IS NULL AND project_pk = $1`,
  ],
  segments: [`UPDATE sections SET ${SOFT} WHERE deleted_at IS NULL AND segment_pk = $1`],
  sections: [],
}

// number of active items underneath, for the delete confirmation dialog
const IMPACT: Record<Key, string> = {
  projects: `SELECT
      (SELECT count(*) FROM segments WHERE project_pk = $1 AND deleted_at IS NULL)::int AS segments,
      (SELECT count(*) FROM sections x JOIN segments s ON s.pk = x.segment_pk
         WHERE s.project_pk = $1 AND x.deleted_at IS NULL)::int AS sections`,
  segments: `SELECT 0 AS segments,
      (SELECT count(*) FROM sections WHERE segment_pk = $1 AND deleted_at IS NULL)::int AS sections`,
  sections: `SELECT 0 AS segments, 0 AS sections`,
}

;(Object.keys(LEVELS) as Key[]).forEach((key) => {
  const cfg = LEVELS[key]

  // EDIT: change ID and name (section: plus route)
  cableRouter.patch(
    `/cable/${key}/:pk`,
    canEdit,
    wrap(async (req, res) => {
      const schema = cfg.hasRoute ? sectionBody : baseBody
      const b = schema.safeParse(req.body)
      if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
      const data = b.data as { id: string; name: string; route?: string }

      const sql = cfg.hasRoute
        ? `UPDATE sections
           SET section_id = $1, name = $2,
               route_id = (SELECT route_id FROM routes WHERE name = $3)
           WHERE pk = $4 AND deleted_at IS NULL
           RETURNING pk, section_id AS id, name`
        : `UPDATE ${cfg.table} SET ${cfg.idCol} = $1, name = $2
           WHERE pk = $3 AND deleted_at IS NULL
           RETURNING pk, ${cfg.idCol} AS id, name`
      const params = cfg.hasRoute
        ? [data.id, data.name, data.route, req.params.pk]
        : [data.id, data.name, req.params.pk]

      try {
        const { rows } = await pool.query(sql, params)
        if (!rows[0]) return res.status(404).json({ message: 'Item not found' })
        res.json(rows[0])
      } catch (e) {
        if (pgCode(e) === '23505') return res.status(409).json({ message: DUPLICATE[key] })
        throw e
      }
    }),
  )

  // IMPACT: how many items underneath would be deleted too
  cableRouter.get(
    `/cable/${key}/:pk/impact`,
    canEdit,
    wrap(async (req, res) => {
      const found = await pool.query(
        `SELECT pk FROM ${cfg.table} WHERE pk = $1 AND deleted_at IS NULL`,
        [req.params.pk],
      )
      if (!found.rows[0]) return res.status(404).json({ message: 'Item not found' })
      const { rows } = await pool.query(IMPACT[key], [req.params.pk])
      res.json(rows[0])
    }),
  )

  // DELETE: soft delete; every child is marked deleted in the same transaction
  cableRouter.delete(
    `/cable/${key}/:pk`,
    canEdit,
    wrap(async (req, res) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const found = await client.query(
          `SELECT pk FROM ${cfg.table} WHERE pk = $1 AND deleted_at IS NULL FOR UPDATE`,
          [req.params.pk],
        )
        if (!found.rows[0]) {
          await client.query('ROLLBACK')
          return res.status(404).json({ message: 'Item not found' })
        }
        for (const sql of CASCADE[key]) await client.query(sql, [req.params.pk, req.user!.id])
        await client.query(`UPDATE ${cfg.table} SET ${SOFT} WHERE pk = $1`, [
          req.params.pk,
          req.user!.id,
        ])
        await client.query('COMMIT')
        res.json({ ok: true })
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw e
      } finally {
        client.release()
      }
    }),
  )
})