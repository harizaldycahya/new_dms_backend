import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

/* =====================================================================
   Master Ticket > Root Cause
   Root Cause (root) > Sub (sub) > Detail (detail)
   Letakkan di: modules/master-ticket/rootCause.routes.ts
   ===================================================================== */

export const rootCauseRouter = Router()

// TODO: samakan dengan key menu Master Ticket di tabel akses kamu
// (harus sama dengan MENU_KEY di RootCauseTab.tsx)
const MENU = 'master-ticket'

rootCauseRouter.use('/master-ticket', requireAuth)
const canEdit = requireMenu(MENU, 'edit')

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pgCode = (e: unknown) => (e as { code?: string }).code

type Level = 'root' | 'sub' | 'detail'

const LEVELS: Record<Level, { table: string; parentTable: string | null; max: number; dup: string }> = {
  root: { table: 'root_cause', parentTable: null, max: 100, dup: 'This Root Cause already exists' },
  sub: { table: 'root_cause_sub', parentTable: 'root_cause', max: 100, dup: 'This Sub already exists under the same Root Cause' },
  detail: { table: 'root_cause_detail', parentTable: 'root_cause_sub', max: 1000, dup: 'This Detail already exists' },
}

// :level and :id are validated once for every route below
rootCauseRouter.param('level', (_req, res, next, value) => {
  if (value in LEVELS) return next()
  res.status(404).json({ message: 'Item not found' })
})
rootCauseRouter.param('id', (_req, res, next, value) => {
  if (/^\d{1,9}$/.test(String(value))) return next()
  res.status(404).json({ message: 'Item not found' })
})

const bodyFor = (level: Level) =>
  z.object({
    name: z.string().trim().min(1, 'Name is required').max(LEVELS[level].max, `Name must be at most ${LEVELS[level].max} characters`),
    is_active: z.boolean().default(true),
    parent_id: z.number().int().positive().nullable().optional(),
  })

const patchFor = (level: Level) =>
  z.object({
    name: z.string().trim().min(1, 'Name is required').max(LEVELS[level].max, `Name must be at most ${LEVELS[level].max} characters`).optional(),
    is_active: z.boolean().optional(),
    parent_id: z.number().int().positive().nullable().optional(),
  })

/* ---------- whole tree in one request (data kecil, ~200 baris) ---------- */
rootCauseRouter.get(
  '/master-ticket/root-cause/tree',
  wrap(async (_req, res) => {
    const [roots, subs, details] = await Promise.all([
      pool.query(
        `SELECT id, name, is_active, NULL::int AS parent_id
         FROM root_cause WHERE deleted_at IS NULL ORDER BY name`,
      ),
      pool.query(
        `SELECT id, name, is_active, parent_id
         FROM root_cause_sub WHERE deleted_at IS NULL ORDER BY name`,
      ),
      pool.query(
        `SELECT id, name, is_active, parent_id
         FROM root_cause_detail WHERE deleted_at IS NULL ORDER BY name`,
      ),
    ])
    res.json({ roots: roots.rows, subs: subs.rows, details: details.rows })
  }),
)

/* ---------- ADD ---------- */
rootCauseRouter.post(
  '/master-ticket/root-cause/:level',
  canEdit,
  wrap(async (req, res) => {
    const level = req.params.level as Level
    const cfg = LEVELS[level]
    const b = bodyFor(level).safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const { name, is_active, parent_id } = b.data

    try {
      if (!cfg.parentTable) {
        const { rows } = await pool.query(
          `INSERT INTO ${cfg.table} (name, is_active, created_by) VALUES ($1, $2, $3)
           RETURNING id, name, is_active, NULL::int AS parent_id`,
          [name, is_active, req.user!.id],
        )
        return res.status(201).json(rows[0])
      }
      if (parent_id == null) return res.status(400).json({ message: 'Parent is required' })
      const { rows } = await pool.query(
        `INSERT INTO ${cfg.table} (parent_id, name, is_active, created_by)
         SELECT p.id, $2, $3, $4 FROM ${cfg.parentTable} p
         WHERE p.id = $1 AND p.deleted_at IS NULL
         RETURNING id, name, is_active, parent_id`,
        [parent_id, name, is_active, req.user!.id],
      )
      if (!rows[0]) return res.status(404).json({ message: 'Parent item not found' })
      res.status(201).json(rows[0])
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: cfg.dup })
      throw e
    }
  }),
)

/* ---------- EDIT (partial: hanya field yang dikirim yang diubah) ---------- */
rootCauseRouter.patch(
  '/master-ticket/root-cause/:level/:id',
  canEdit,
  wrap(async (req, res) => {
    const level = req.params.level as Level
    const cfg = LEVELS[level]
    const b = patchFor(level).safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const { name, is_active, parent_id } = b.data

    const sets: string[] = []
    const params: unknown[] = []
    const add = (col: string, v: unknown) => {
      params.push(v)
      sets.push(`${col} = $${params.length}`)
    }
    if (name !== undefined) add('name', name)
    if (is_active !== undefined) add('is_active', is_active)
    if (cfg.parentTable && parent_id !== undefined) {
      if (parent_id !== null) {
        const p = await pool.query(`SELECT 1 FROM ${cfg.parentTable} WHERE id = $1 AND deleted_at IS NULL`, [parent_id])
        if (!p.rows[0]) return res.status(404).json({ message: 'Parent item not found' })
      }
      add('parent_id', parent_id)
    }
    if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' })

    params.push(req.params.id)
    const parentCol = cfg.parentTable ? 'parent_id' : 'NULL::int AS parent_id'
    try {
      const { rows } = await pool.query(
        `UPDATE ${cfg.table} SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${params.length} AND deleted_at IS NULL
         RETURNING id, name, is_active, ${parentCol}`,
        params,
      )
      if (!rows[0]) return res.status(404).json({ message: 'Item not found' })
      res.json(rows[0])
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: cfg.dup })
      throw e
    }
  }),
)

/* ---------- IMPACT: how many items underneath would be deleted too ---------- */
rootCauseRouter.get(
  '/master-ticket/root-cause/:level/:id/impact',
  canEdit,
  wrap(async (req, res) => {
    const level = req.params.level as Level
    const cfg = LEVELS[level]
    const found = await pool.query(`SELECT id FROM ${cfg.table} WHERE id = $1 AND deleted_at IS NULL`, [req.params.id])
    if (!found.rows[0]) return res.status(404).json({ message: 'Item not found' })

    if (level === 'root') {
      const { rows } = await pool.query(
        `SELECT
           (SELECT count(*) FROM root_cause_sub WHERE parent_id = $1 AND deleted_at IS NULL)::int AS subs,
           (SELECT count(*) FROM root_cause_detail d JOIN root_cause_sub s ON s.id = d.parent_id
              WHERE s.parent_id = $1 AND s.deleted_at IS NULL AND d.deleted_at IS NULL)::int AS details`,
        [req.params.id],
      )
      return res.json(rows[0])
    }
    if (level === 'sub') {
      const { rows } = await pool.query(
        `SELECT 0 AS subs,
                (SELECT count(*) FROM root_cause_detail WHERE parent_id = $1 AND deleted_at IS NULL)::int AS details`,
        [req.params.id],
      )
      return res.json(rows[0])
    }
    res.json({ subs: 0, details: 0 })
  }),
)

/* ---------- DELETE: soft delete; every child is marked deleted in the same transaction ---------- */
const SOFT = 'deleted_at = now(), deleted_by = $2'

const CASCADE: Record<Level, string[]> = {
  root: [
    `UPDATE root_cause_detail SET ${SOFT} WHERE deleted_at IS NULL AND parent_id IN (
       SELECT id FROM root_cause_sub WHERE parent_id = $1)`,
    `UPDATE root_cause_sub SET ${SOFT} WHERE deleted_at IS NULL AND parent_id = $1`,
  ],
  sub: [`UPDATE root_cause_detail SET ${SOFT} WHERE deleted_at IS NULL AND parent_id = $1`],
  detail: [],
}

rootCauseRouter.delete(
  '/master-ticket/root-cause/:level/:id',
  canEdit,
  wrap(async (req, res) => {
    const level = req.params.level as Level
    const cfg = LEVELS[level]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query(`SELECT id FROM ${cfg.table} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id])
      if (!found.rows[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ message: 'Item not found' })
      }
      for (const sql of CASCADE[level]) await client.query(sql, [req.params.id, req.user!.id])
      await client.query(`UPDATE ${cfg.table} SET ${SOFT} WHERE id = $1`, [req.params.id, req.user!.id])
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