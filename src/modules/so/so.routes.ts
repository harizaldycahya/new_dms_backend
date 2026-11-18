import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

export const soRouter = Router()

// semua endpoint /so hanya untuk menu master-so (SUPER_ADMIN)
soRouter.use('/so', requireAuth, requireMenu('master-so'))
const canEdit = requireMenu('master-so', 'edit')

for (const name of ['pk', 'parentPk']) {
  soRouter.param(name, (_req, res, next, value) => {
    if (/^\d{1,18}$/.test(String(value))) return next()
    res.status(404).json({ message: 'Item not found' })
  })
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pgCode = (e: unknown) => (e as { code?: string }).code

// name opsional: level Worker mengambil nama dari user yang dipilih.
// pic_user_id dipakai untuk semua level yang terhubung ke user (PIC di Area/Service Point, user di Worker).
const body = z.object({
  name: z.string().trim().max(150, 'Name must be at most 150 characters').optional(),
  pic_user_id: z.number().int().positive().nullable().optional(),
})

/* =====================  USER (PIC & WORKER)  =====================
   Role yang TIDAK boleh dipilih. */
const EXCLUDED_ROLES = ['SUPER_ADMIN', 'ENGINEERING']

/* =====================  konfigurasi tiap level  =====================
   Area -> Cluster -> Service Point -> Worker
   parent.path = alamat list/tambah anak di bawah induknya.
   userCol     = kolom FK ke users (PIC untuk Area/Service Point, user untuk Worker).
   nameFromUser = nama item diambil dari user yang dipilih. */
type Key = 'areas' | 'clusters' | 'service-points' | 'workers'

type Cfg = {
  table: string
  idCol: string
  userCol?: string
  nameFromUser?: boolean
  parent?: { table: string; col: string; path: string }
  child?: { table: string; fk: string }
}

const CFG: Record<Key, Cfg> = {
  areas: {
    table: 'so_areas',
    idCol: 'area_id',
    userCol: 'pic_user_id',
    child: { table: 'so_clusters', fk: 'area_pk' },
  },
  clusters: {
    table: 'so_clusters',
    idCol: 'cluster_id',
    parent: { table: 'so_areas', col: 'area_pk', path: '/so/areas/:parentPk/clusters' },
    child: { table: 'so_service_points', fk: 'cluster_pk' },
  },
  'service-points': {
    table: 'so_service_points',
    idCol: 'service_point_id',
    userCol: 'pic_user_id',
    parent: { table: 'so_clusters', col: 'cluster_pk', path: '/so/clusters/:parentPk/service-points' },
    child: { table: 'so_workers', fk: 'service_point_pk' },
  },
  workers: {
    table: 'so_workers',
    idCol: 'worker_id',
    userCol: 'user_id',
    nameFromUser: true,
    parent: { table: 'so_service_points', col: 'service_point_pk', path: '/so/service-points/:parentPk/workers' },
  },
}
const KEYS = Object.keys(CFG) as Key[]

// Di response, kolom user selalu bernama pic_user_id / pic_name supaya frontend seragam.
const userSelect = (cfg: Cfg) =>
  cfg.userCol
    ? `t.${cfg.userCol} AS pic_user_id, u.name AS pic_name`
    : 'NULL::int AS pic_user_id, NULL::text AS pic_name'
const userJoin = (cfg: Cfg) => (cfg.userCol ? `LEFT JOIN users u ON u.id = t.${cfg.userCol}` : '')
const nameSelect = (cfg: Cfg) => (cfg.nameFromUser ? 'COALESCE(u.name, t.name)' : 't.name')

// true = user tidak valid (tidak ada / nonaktif / role terlarang).
// `keep`: saat edit, user yang sudah terpasang boleh dipertahankan walau sekarang tidak memenuhi syarat.
async function userInvalid(userId: number | null, cfg: Cfg, keep?: { pk: string }) {
  if (userId == null) return false
  const ok = await pool.query(
    `SELECT 1 FROM users WHERE id = $1 AND active = true AND role::text <> ALL($2::text[])`,
    [userId, EXCLUDED_ROLES],
  )
  if (ok.rows[0]) return false
  if (keep && cfg.userCol) {
    const same = await pool.query(`SELECT 1 FROM ${cfg.table} WHERE pk = $1 AND ${cfg.userCol} = $2`, [
      keep.pk,
      userId,
    ])
    if (same.rows[0]) return false
  }
  return true
}

// validasi input + tentukan nama final dan user
async function resolveInput(
  cfg: Cfg,
  data: z.infer<typeof body>,
  keep?: { pk: string },
): Promise<{ name: string; userId: number | null } | { error: string }> {
  const userId = cfg.userCol ? (data.pic_user_id ?? null) : null

  if (cfg.nameFromUser) {
    if (userId == null) return { error: 'Worker is required' }
  } else if (!data.name) {
    return { error: 'Name is required' }
  }

  if (await userInvalid(userId, cfg, keep)) return { error: 'User is not eligible' }
  if (!cfg.nameFromUser) return { name: data.name!, userId }

  const u = await pool.query(`SELECT name FROM users WHERE id = $1`, [userId])
  return { name: u.rows[0].name as string, userId }
}

// error umum untuk insert/update
const writeError = (e: unknown, res: Response) => {
  if (pgCode(e) === '23505') return res.status(409).json({ message: 'Duplicate data, please try again' })
  if (pgCode(e) === '23503') return res.status(400).json({ message: 'User not found' })
  throw e
}

const childCount = (cfg: Cfg, alias: string) =>
  cfg.child
    ? `(SELECT count(*) FROM ${cfg.child.table} ch WHERE ch.${cfg.child.fk} = ${alias}.pk AND ch.deleted_at IS NULL)::int`
    : '0'

/* =====================  DAFTAR USER UNTUK DROPDOWN (PIC & WORKER)  ===================== */
soRouter.get(
  '/so/users',
  wrap(async (req, res) => {
    // escape % dan _ supaya dianggap teks biasa di ILIKE
    const q = String(req.query.q ?? '')
      .trim() 
      .slice(0, 100)
      .replace(/[\\%_]/g, '\\$&')
    const { rows } = await pool.query(
      `SELECT id, name, username FROM users
       WHERE active = true AND role::text <> ALL($1::text[])
         AND ($2::text = '' OR name ILIKE '%' || $2::text || '%' OR username ILIKE '%' || $2::text || '%')
       ORDER BY name
       LIMIT 30`,
      [EXCLUDED_ROLES, q],
    )
    res.json({ items: rows })
  }),
)
/* =====================  LIST + TAMBAH  ===================== */
for (const key of KEYS) {
  const cfg = CFG[key]
  const path = cfg.parent ? cfg.parent.path : '/so/areas'

  const listSql = `SELECT t.pk, t.${cfg.idCol} AS id, ${nameSelect(cfg)} AS name, ${userSelect(cfg)},
      ${childCount(cfg, 't')} AS child_count
    FROM ${cfg.table} t ${userJoin(cfg)}
    WHERE ${cfg.parent ? `t.${cfg.parent.col} = $1 AND ` : ''}t.deleted_at IS NULL
    ORDER BY t.name`

  soRouter.get(
    path,
    wrap(async (req, res) => {
      const { rows } = await pool.query(listSql, cfg.parent ? [req.params.parentPk] : [])
      res.json({ items: rows })
    }),
  )

  soRouter.post(
    path,
    canEdit,
    wrap(async (req, res) => {
      const b = body.safeParse(req.body)
      if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })

      const r = await resolveInput(cfg, b.data)
      if ('error' in r) return res.status(400).json({ message: r.error })

      // ID (idCol) tidak diikutkan: database mengisinya lewat DEFAULT sequence
      const cols = ['name']
      const vals: unknown[] = [r.name]
      if (cfg.userCol) {
        cols.push(cfg.userCol)
        vals.push(r.userId)
      }
      cols.push('created_by')
      vals.push(req.user!.id)

      // untuk level dengan parent, $1 = parentPk
      const off = cfg.parent ? 2 : 1
      const ph = vals.map((_, i) => `$${i + off}${cols[i] === cfg.userCol ? '::int' : ''}`)

      const ret = `RETURNING pk, ${cfg.idCol} AS id, name, ${
        cfg.userCol ? `${cfg.userCol} AS pic_user_id` : 'NULL::int AS pic_user_id'
      }, 0 AS child_count`
      const sql = cfg.parent
        ? `INSERT INTO ${cfg.table} (${cfg.parent.col}, ${cols.join(', ')})
           SELECT p.pk, ${ph.join(', ')} FROM ${cfg.parent.table} p
           WHERE p.pk = $1 AND p.deleted_at IS NULL ${ret}`
        : `INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${ph.join(', ')}) ${ret}`
      const params = cfg.parent ? [req.params.parentPk, ...vals] : vals

      try {
        const { rows } = await pool.query(sql, params)
        if (!rows[0]) return res.status(404).json({ message: 'Parent item not found' })
        res.status(201).json(rows[0])
      } catch (e) {
        writeError(e, res)
      }
    }),
  )
}

/* =====================  SELURUH POHON dalam satu request  ===================== */
soRouter.get(
  '/so/tree',
  wrap(async (_req, res) => {
    const level = (key: Key) => {
      const cfg = CFG[key]
      return pool.query(
        `SELECT t.pk, t.${cfg.idCol} AS id, ${nameSelect(cfg)} AS name, t.${cfg.parent!.col} AS parent_pk,
                ${userSelect(cfg)}, ${childCount(cfg, 't')} AS child_count
         FROM ${cfg.table} t ${userJoin(cfg)}
         WHERE t.deleted_at IS NULL
         ORDER BY t.name`,
      )
    }
    const [clusters, servicePoints, workers] = await Promise.all([
      level('clusters'),
      level('service-points'),
      level('workers'),
    ])
    res.json({ clusters: clusters.rows, servicePoints: servicePoints.rows, workers: workers.rows })
  }),
)

/* =====================  EDIT + HAPUS (SOFT DELETE)  ===================== */
const SOFT = 'deleted_at = now(), deleted_by = $2'

// $1 = pk yang dihapus, $2 = id user. Urutan: level terdalam dulu.
const CASCADE: Record<Key, string[]> = {
  areas: [
    `UPDATE so_workers SET ${SOFT} WHERE deleted_at IS NULL AND service_point_pk IN (
       SELECT sp.pk FROM so_service_points sp
       WHERE sp.cluster_pk IN (SELECT pk FROM so_clusters WHERE area_pk = $1))`,
    `UPDATE so_service_points SET ${SOFT} WHERE deleted_at IS NULL AND cluster_pk IN (
       SELECT pk FROM so_clusters WHERE area_pk = $1)`,
    `UPDATE so_clusters SET ${SOFT} WHERE deleted_at IS NULL AND area_pk = $1`,
  ],
  clusters: [
    `UPDATE so_workers SET ${SOFT} WHERE deleted_at IS NULL AND service_point_pk IN (
       SELECT pk FROM so_service_points WHERE cluster_pk = $1)`,
    `UPDATE so_service_points SET ${SOFT} WHERE deleted_at IS NULL AND cluster_pk = $1`,
  ],
  'service-points': [`UPDATE so_workers SET ${SOFT} WHERE deleted_at IS NULL AND service_point_pk = $1`],
  workers: [],
}

// jumlah item aktif di bawahnya, untuk dialog konfirmasi hapus
const IMPACT: Record<Key, string> = {
  areas: `SELECT
      (SELECT count(*) FROM so_clusters WHERE area_pk = $1 AND deleted_at IS NULL)::int AS clusters,
      (SELECT count(*) FROM so_service_points sp JOIN so_clusters c ON c.pk = sp.cluster_pk
         WHERE c.area_pk = $1 AND sp.deleted_at IS NULL)::int AS service_points,
      (SELECT count(*) FROM so_workers w
         JOIN so_service_points sp ON sp.pk = w.service_point_pk
         JOIN so_clusters c ON c.pk = sp.cluster_pk
         WHERE c.area_pk = $1 AND w.deleted_at IS NULL)::int AS workers`,
  clusters: `SELECT 0 AS clusters,
      (SELECT count(*) FROM so_service_points WHERE cluster_pk = $1 AND deleted_at IS NULL)::int AS service_points,
      (SELECT count(*) FROM so_workers w JOIN so_service_points sp ON sp.pk = w.service_point_pk
         WHERE sp.cluster_pk = $1 AND w.deleted_at IS NULL)::int AS workers`,
  'service-points': `SELECT 0 AS clusters, 0 AS service_points,
      (SELECT count(*) FROM so_workers WHERE service_point_pk = $1 AND deleted_at IS NULL)::int AS workers`,
  workers: `SELECT 0 AS clusters, 0 AS service_points, 0 AS workers`,
}

for (const key of KEYS) {
  const cfg = CFG[key]

  // EDIT: ubah nama (+ PIC untuk Area & Service Point, user untuk Worker). ID tidak bisa diubah.
  soRouter.patch(
    `/so/${key}/:pk`,
    canEdit,
    wrap(async (req, res) => {
      const b = body.safeParse(req.body)
      if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })

      const r = await resolveInput(cfg, b.data, { pk: req.params.pk })
      if ('error' in r) return res.status(400).json({ message: r.error })

      const params: unknown[] = [r.name]
      const sets = ['name = $1']
      if (cfg.userCol) {
        params.push(r.userId)
        sets.push(`${cfg.userCol} = $${params.length}::int`)
      }
      params.push(req.params.pk)

      try {
        const { rows } = await pool.query(
          `UPDATE ${cfg.table} SET ${sets.join(', ')}
           WHERE pk = $${params.length} AND deleted_at IS NULL
           RETURNING pk, ${cfg.idCol} AS id, name`,
          params,
        )
        if (!rows[0]) return res.status(404).json({ message: 'Item not found' })
        res.json(rows[0])
      } catch (e) {
        writeError(e, res)
      }
    }),
  )

  // IMPACT: berapa item di bawahnya yang ikut terhapus
  soRouter.get(
    `/so/${key}/:pk/impact`,
    canEdit,
    wrap(async (req, res) => {
      const found = await pool.query(`SELECT pk FROM ${cfg.table} WHERE pk = $1 AND deleted_at IS NULL`, [
        req.params.pk,
      ])
      if (!found.rows[0]) return res.status(404).json({ message: 'Item not found' })
      const { rows } = await pool.query(IMPACT[key], [req.params.pk])
      res.json(rows[0])
    }),
  )

  // DELETE: soft delete; semua anak ikut ditandai terhapus dalam satu transaksi
  soRouter.delete(
    `/so/${key}/:pk`,
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
        await client.query(`UPDATE ${cfg.table} SET ${SOFT} WHERE pk = $1`, [req.params.pk, req.user!.id])
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
}