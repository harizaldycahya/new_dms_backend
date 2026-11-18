import { Router, type NextFunction, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'
import { MENUS, MENU_BY_KEY } from './menus.js'

export const accessRouter = Router()

// semua endpoint di sini hanya untuk menu master-user (SUPER_ADMIN)
accessRouter.use(['/users', '/roles'], requireAuth, requireMenu('master-user'))

for (const name of ['id', 'pk']) {
  accessRouter.param(name, (_req, res, next, value) => {
    if (/^\d{1,18}$/.test(String(value))) return next()
    res.status(404).json({ message: 'Item not found' })
  })
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pgCode = (e: unknown) => (e as { code?: string }).code

async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    c.release()
  }
}

const findRole = async (pk: string | string[]) =>
  (
    await pool.query('SELECT pk, name, is_system FROM roles WHERE pk = $1 AND deleted_at IS NULL', [
      String(pk),
    ])
  ).rows[0] as { pk: string; name: string; is_system: boolean } | undefined
/* =====================  USERS  ===================== */

const password = z.string().min(8, 'Password must be at least 8 characters').max(100)
const rolePk = z.string().regex(/^\d{1,18}$/, 'Role is required')
const nameField = z.string().trim().min(1, 'Name is required').max(150)

const createUserBody = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, 'Username may only contain letters, numbers, dots, hyphens, and underscores'),
  name: nameField,
  password,
  role_pk: rolePk,
  active: z.boolean(),
})
const updateUserBody = z.object({
  name: nameField,
  password: password.optional(),
  role_pk: rolePk,
  active: z.boolean(),
})

accessRouter.get(
  '/users',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.name, u.active, u.created_at,
              u.role_pk::text AS role_pk, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.pk = u.role_pk
       ORDER BY lower(u.username)`,
    )
    res.json({ items: rows })
  }),
)

accessRouter.post(
  '/users',
  wrap(async (req, res) => {
    const b = createUserBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const role = await findRole(b.data.role_pk)
    if (!role) return res.status(400).json({ message: 'Role not found' })

    const dup = await pool.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.data.username])
    if (dup.rows[0]) return res.status(409).json({ message: 'This username is already used' })

    const hash = await bcrypt.hash(b.data.password, 10)
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (username, name, password_hash, role, role_pk, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [b.data.username, b.data.name, hash, role.name, role.pk, b.data.active],
      )
      res.status(201).json(rows[0])
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: 'This username is already used' })
      throw e
    }
  }),
)

accessRouter.patch(
  '/users/:id',
  wrap(async (req, res) => {
    const b = updateUserBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const id = Number(req.params.id)

    const cur = await pool.query('SELECT role_pk::text AS role_pk FROM users WHERE id = $1', [id])
    if (!cur.rows[0]) return res.status(404).json({ message: 'User not found' })

    // mencegah super admin mengunci dirinya sendiri
    if (id === req.user!.id && (!b.data.active || b.data.role_pk !== cur.rows[0].role_pk)) {
      return res.status(400).json({ message: 'You cannot change your own role or deactivate yourself' })
    }

    const role = await findRole(b.data.role_pk)
    if (!role) return res.status(400).json({ message: 'Role not found' })

    const hash = b.data.password ? await bcrypt.hash(b.data.password, 10) : null
    await pool.query(
      `UPDATE users
       SET name = $1, role_pk = $2, role = $3, active = $4,
           password_hash = COALESCE($5, password_hash)
       WHERE id = $6`,
      [b.data.name, role.pk, role.name, b.data.active, hash, id],
    )
    res.json({ ok: true })
  }),
)

/* =====================  ROLES  ===================== */

const roleBody = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Role name is required')
    .max(50)
    .regex(/^[A-Za-z0-9_]+$/, 'Role name may only contain letters, numbers, and underscores')
    .transform((s) => s.toUpperCase()),
  description: z.string().trim().max(300).default(''),
  menus: z.array(z.object({ key: z.string(), edit: z.boolean() })).max(50),
})

// validasi menu terhadap katalog; master-user tidak boleh diberikan ke role biasa
function cleanMenus(menus: { key: string; edit: boolean }[]) {
  const out = new Map<string, { key: string; edit: boolean }>()
  for (const m of menus) {
    const def = MENU_BY_KEY.get(m.key)
    if (!def || def.superOnly) return null
    out.set(def.key, { key: def.key, edit: m.edit && def.hasEdit })
  }
  return [...out.values()]
}

async function saveMenus(c: PoolClient, rolePk: string, menus: { key: string; edit: boolean }[]) {
  await c.query('DELETE FROM role_menus WHERE role_pk = $1', [rolePk])
  for (const m of menus) {
    await c.query('INSERT INTO role_menus (role_pk, menu_key, can_edit) VALUES ($1, $2, $3)', [
      rolePk,
      m.key,
      m.edit,
    ])
  }
}

const DUP_ROLE = 'This role name is already used'

accessRouter.get('/roles/menus', (_req, res) => {
  res.json({
    items: MENUS.filter((m) => !m.superOnly).map(({ key, label, hasEdit }) => ({ key, label, hasEdit })),
  })
})

accessRouter.get(
  '/roles',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT r.pk::text AS pk, r.name, r.description, r.is_system,
              (SELECT count(*) FROM users u WHERE u.role_pk = r.pk)::int AS user_count,
              COALESCE((SELECT json_agg(json_build_object('key', rm.menu_key, 'edit', rm.can_edit))
                        FROM role_menus rm WHERE rm.role_pk = r.pk), '[]'::json) AS menus
       FROM roles r
       WHERE r.deleted_at IS NULL
       ORDER BY r.is_system DESC, r.name`,
    )
    res.json({ items: rows })
  }),
)

accessRouter.post(
  '/roles',
  wrap(async (req, res) => {
    const b = roleBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const menus = cleanMenus(b.data.menus)
    if (!menus) return res.status(400).json({ message: 'Invalid menu selection' })

    try {
      const row = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING pk::text AS pk, name`,
          [b.data.name, b.data.description],
        )
        await saveMenus(c, rows[0].pk, menus)
        return rows[0]
      })
      res.status(201).json(row)
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: DUP_ROLE })
      throw e
    }
  }),
)

accessRouter.patch(
  '/roles/:pk',
  wrap(async (req, res) => {
    const b = roleBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const menus = cleanMenus(b.data.menus)
    if (!menus) return res.status(400).json({ message: 'Invalid menu selection' })

    const role = await findRole(req.params.pk)
    if (!role) return res.status(404).json({ message: 'Role not found' })
    if (role.is_system) return res.status(403).json({ message: 'System role cannot be changed' })

    try {
      await tx(async (c) => {
        await c.query('UPDATE roles SET name = $1, description = $2 WHERE pk = $3', [
          b.data.name,
          b.data.description,
          role.pk,
        ])
        await c.query('UPDATE users SET role = $1 WHERE role_pk = $2', [b.data.name, role.pk])
        await saveMenus(c, role.pk, menus)
      })
      res.json({ ok: true })
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: DUP_ROLE })
      throw e
    }
  }),
)

accessRouter.delete(
  '/roles/:pk',
  wrap(async (req, res) => {
    const role = await findRole(req.params.pk)
    if (!role) return res.status(404).json({ message: 'Role not found' })
    if (role.is_system) return res.status(403).json({ message: 'System role cannot be deleted' })

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE role_pk = $1', [role.pk])
    if (rows[0].n > 0) {
      return res
        .status(409)
        .json({ message: `This role is used by ${rows[0].n} user(s). Move them to another role first.` })
    }
    await pool.query('UPDATE roles SET deleted_at = now() WHERE pk = $1', [role.pk])
    res.json({ ok: true })
  }),
)