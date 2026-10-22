import { Router } from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { pool } from '../../db.js'
import { env } from '../../env.js'
import { requireAuth, type AuthUser } from '../../middleware/auth.js'

export const authRouter = Router()

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

function signSession(u: AuthUser) {
  return jwt.sign({ id: u.id, username: u.username, name: u.name, role: u.role }, env.jwtSecret, {
    expiresIn: '8h',
  })
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/* ---------- Login langsung (username + password) ---------- */
authRouter.post('/auth/login', async (req, res) => {
  const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body)
  if (!body.success) return res.status(400).json({ message: 'Username dan password wajib diisi' })

  const { rows } = await pool.query(
    'SELECT id, username, name, role, password_hash, active FROM users WHERE lower(username) = lower($1)',
    [body.data.username.trim()],
  )
  const u = rows[0]
  const ok = u && u.active && (await bcrypt.compare(body.data.password, u.password_hash))
  if (!ok) return res.status(401).json({ message: 'Username atau password salah' })

  const user = { id: u.id, username: u.username, name: u.name, role: u.role }
  res.json({ token: signSession(user), user })
})

/* ---------- Dipanggil PORTAL (server ke server) ---------- */
authRouter.get('/api/public/get-token/:username', async (req, res) => {
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!safeEqual(bearer, env.ssoSharedToken)) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const { rows } = await pool.query(
    'SELECT id FROM users WHERE lower(username) = lower($1) AND active = true',
    [req.params.username.trim()],
  )
  if (!rows[0]) return res.json({ result: { access_token: null } })

  const raw = crypto.randomBytes(32).toString('hex')
  await pool.query(
    `INSERT INTO sso_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '60 seconds')`,
    [sha256(raw), rows[0].id],
  )
  res.json({ result: { access_token: raw } })
})

/* ---------- Dipanggil FRONTEND (halaman /sso/:token) ---------- */
authRouter.post('/auth/sso/exchange', async (req, res) => {
  const body = z.object({ token: z.string().min(10) }).safeParse(req.body)
  if (!body.success) return res.status(400).json({ message: 'Token tidak valid' })

  // satu query atomik: hanya berhasil kalau belum dipakai dan belum kedaluwarsa
  const { rows } = await pool.query(
    `UPDATE sso_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256(body.data.token)],
  )
  if (!rows[0]) return res.status(401).json({ message: 'Link login sudah kedaluwarsa, buka ulang dari portal' })

  const { rows: users } = await pool.query(
    'SELECT id, username, name, role FROM users WHERE id = $1 AND active = true',
    [rows[0].user_id],
  )
  const u = users[0]
  if (!u) return res.status(401).json({ message: 'Akun tidak aktif' })

  const user = { id: u.id, username: u.username, name: u.name, role: u.role }
  res.json({ token: signSession(user), user })
})

/* ---------- Cek sesi ---------- */
authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})