import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

export const customerRouter = Router()

// semua endpoint /customer hanya untuk menu master-customer (SUPER_ADMIN)
customerRouter.use('/customer', requireAuth, requireMenu('master-customer'))
const canEdit = requireMenu('master-customer', 'edit')

customerRouter.param('pk', (_req, res, next, value) => {
  if (/^\d{1,18}$/.test(String(value))) return next()
  res.status(404).json({ message: 'Item not found' })
})

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pgCode = (e: unknown) => (e as { code?: string }).code

const body = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'Customer ID is required')
    .max(50, 'Customer ID must be at most 50 characters')
    .regex(/^[A-Za-z0-9._-]+$/, 'Customer ID may only contain letters, numbers, dots, hyphens, and underscores'),
  name: z.string().trim().min(1, 'Name is required').max(150, 'Name must be at most 150 characters'),
})

const DUP = 'This Customer ID is already used'

/* =====================  CUSTOMERS  ===================== */
customerRouter.get(
  '/customer/customers',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT pk::text AS pk, customer_id AS id, name
       FROM customers
       WHERE deleted_at IS NULL
       ORDER BY customer_id`,
    )
    res.json({ items: rows })
  }),
)

customerRouter.post(
  '/customer/customers',
  canEdit,
  wrap(async (req, res) => {
    const b = body.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    try {
      const { rows } = await pool.query(
        `INSERT INTO customers (customer_id, name, created_by)
         VALUES ($1, $2, $3)
         RETURNING pk::text AS pk, customer_id AS id, name`,
        [b.data.id, b.data.name, req.user!.id],
      )
      res.status(201).json(rows[0])
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: DUP })
      throw e
    }
  }),
)

customerRouter.patch(
  '/customer/customers/:pk',
  canEdit,
  wrap(async (req, res) => {
    const b = body.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    try {
      const { rows } = await pool.query(
        `UPDATE customers SET customer_id = $1, name = $2
         WHERE pk = $3 AND deleted_at IS NULL
         RETURNING pk::text AS pk, customer_id AS id, name`,
        [b.data.id, b.data.name, req.params.pk],
      )
      if (!rows[0]) return res.status(404).json({ message: 'Customer not found' })
      res.json(rows[0])
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: DUP })
      throw e
    }
  }),
)

// soft delete
customerRouter.delete(
  '/customer/customers/:pk',
  canEdit,
  wrap(async (req, res) => {
    const { rowCount } = await pool.query(
      `UPDATE customers SET deleted_at = now(), deleted_by = $2
       WHERE pk = $1 AND deleted_at IS NULL`,
      [req.params.pk, req.user!.id],
    )
    if (!rowCount) return res.status(404).json({ message: 'Customer not found' })
    res.json({ ok: true })
  }),
)