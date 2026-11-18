import { Router, type NextFunction, type Request, type Response } from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool } from '../../db.js'
import { env } from '../../env.js'

/* =====================================================================
   Endpoint untuk PORTAL (server ke server), dijaga bearer token yang sama
   dengan get-token (env.ssoSharedToken).

     GET  /api/public/roles         -> daftar role untuk form request di portal
     POST /api/public/users         -> buat user (atau perbarui role bila sudah ada)
     PUT  /api/public/users/:nik    -> ubah role user

   Role system (is_system, mis. SUPER_ADMIN) tidak bisa diberikan atau
   diubah lewat portal. User dibuat tanpa password yang bisa dipakai,
   jadi hanya bisa masuk lewat portal (SSO).
   ===================================================================== */

export const portalRouter = Router()

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function requirePortalToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!safeEqual(bearer, env.ssoSharedToken)) return res.status(401).json({ message: 'Unauthorized' })
  next()
}
portalRouter.use('/api/public/roles', requirePortalToken)
portalRouter.use('/api/public/users', requirePortalToken)

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

// role biasa (bukan system) berdasarkan nama, huruf besar/kecil tidak dibedakan
const findRoleByName = async (name: string) =>
  (
    await pool.query(
      'SELECT pk::text AS pk, name FROM roles WHERE lower(name) = lower($1) AND deleted_at IS NULL AND is_system = false',
      [name.trim()],
    )
  ).rows[0] as { pk: string; name: string } | undefined

const nik = z
  .string()
  .trim()
  .min(3)
  .max(50)
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid NIK')

portalRouter.get(
  '/api/public/roles',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT pk::text AS id, name FROM roles
        WHERE deleted_at IS NULL AND is_system = false
        ORDER BY name`,
    )
    res.json({ result: { roles: rows } })
  }),
)

portalRouter.post(
  '/api/public/users',
  wrap(async (req, res) => {
    const b = z
      .object({ nik, name: z.string().trim().min(1).max(150), role: z.string().min(1) })
      .safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })

    const role = await findRoleByName(b.data.role)
    if (!role) return res.status(400).json({ message: 'Role not found' })

    const cur = await pool.query(
      `SELECT u.id, r.is_system FROM users u LEFT JOIN roles r ON r.pk = u.role_pk
        WHERE lower(u.username) = lower($1)`,
      [b.data.nik],
    )
    if (cur.rows[0]) {
      // sudah ada: cukup perbarui role (tidak menyentuh user dengan role system)
      if (cur.rows[0].is_system) return res.status(403).json({ message: 'This user has a system role' })
      await pool.query('UPDATE users SET role_pk = $1, role = $2 WHERE id = $3', [role.pk, role.name, cur.rows[0].id])
      return res.json({ result: { created: false } })
    }

    // password acak yang tidak diketahui siapa pun: login hanya lewat portal
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
    await pool.query(
      `INSERT INTO users (username, name, password_hash, role, role_pk, active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [b.data.nik, b.data.name, hash, role.name, role.pk],
    )
    res.status(201).json({ result: { created: true } })
  }),
)

portalRouter.put(
  '/api/public/users/:nik',
  wrap(async (req, res) => {
    const p = nik.safeParse(req.params.nik)
    const b = z.object({ role: z.string().min(1) }).safeParse(req.body)
    if (!p.success || !b.success) return res.status(400).json({ message: 'Invalid request' })

    const role = await findRoleByName(b.data.role)
    if (!role) return res.status(400).json({ message: 'Role not found' })

    const cur = await pool.query(
      `SELECT u.id, r.is_system FROM users u LEFT JOIN roles r ON r.pk = u.role_pk
        WHERE lower(u.username) = lower($1)`,
      [p.data],
    )
    if (!cur.rows[0]) return res.status(404).json({ message: 'User not found' })
    if (cur.rows[0].is_system) return res.status(403).json({ message: 'This user has a system role' })

    await pool.query('UPDATE users SET role_pk = $1, role = $2 WHERE id = $3', [role.pk, role.name, cur.rows[0].id])
    res.json({ result: { updated: true } })
  }),
)