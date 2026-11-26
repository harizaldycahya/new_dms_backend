import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

export const sectionCustomerRouter = Router()

// same guard as customer.routes.ts, repeated here so it holds regardless of mount order
sectionCustomerRouter.use('/customer/section-customers', requireAuth, requireMenu('master-customer'))
const canEdit = requireMenu('master-customer', 'edit')

sectionCustomerRouter.param('pk', (_req, res, next, value) => {
  if (/^\d{1,18}$/.test(String(value))) return next()
  res.status(404).json({ message: 'Item not found' })
})

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pgCode = (e: unknown) => (e as { code?: string }).code

const pkField = (label: string) =>
  z.string().trim().regex(/^\d{1,18}$/, `${label} is invalid`)

const nameField = z
  .string()
  .trim()
  .min(1, 'Customer section name is required')
  .max(200, 'Customer section name must be at most 200 characters')

const createBody = z.object({
  customer_pk: pkField('Customer'),
  section_pk: pkField('Section'),
  customer_section_name: nameField,
})

const updateBody = z.object({
  customer_section_name: nameField,
})

const DUP = 'This Section is already mapped for this Customer'

// pk columns are bigint; cast to text like customer.routes.ts does
const RETURNING = `pk::text AS pk, customer_pk::text AS customer_pk,
                   section_pk::text AS section_pk, customer_section_name`

/* ---------- LIST ----------
   Mappings of a soft-deleted Customer or Section are hidden. */
sectionCustomerRouter.get(
  '/customer/section-customers',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT sc.pk::text AS pk, sc.customer_pk::text AS customer_pk,
              sc.section_pk::text AS section_pk, sc.customer_section_name
       FROM section_customer sc
       JOIN customers c ON c.pk = sc.customer_pk AND c.deleted_at IS NULL
       JOIN sections s ON s.pk = sc.section_pk AND s.deleted_at IS NULL
       ORDER BY sc.customer_pk, sc.section_pk`,
    )
    res.json({ items: rows })
  }),
)

/* ---------- ADD ---------- */
sectionCustomerRouter.post(
  '/customer/section-customers',
  canEdit,
  wrap(async (req, res) => {
    const b = createBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })

    try {
      const { rows } = await pool.query(
        `INSERT INTO section_customer (customer_pk, section_pk, customer_section_name)
         SELECT c.pk, s.pk, $3
         FROM customers c, sections s
         WHERE c.pk = $1 AND c.deleted_at IS NULL
           AND s.pk = $2 AND s.deleted_at IS NULL
         RETURNING ${RETURNING}`,
        [b.data.customer_pk, b.data.section_pk, b.data.customer_section_name],
      )
      if (!rows[0]) return res.status(404).json({ message: 'Customer or Section not found' })
      res.status(201).json(rows[0])
    } catch (e) {
      if (pgCode(e) === '23505') return res.status(409).json({ message: DUP })
      throw e
    }
  }),
)

/* ---------- ADD MANY: one Customer, many Sections, all-or-nothing ---------- */
const bulkBody = z.object({
  customer_pk: pkField('Customer'),
  items: z
    .array(z.object({ section_pk: pkField('Section'), customer_section_name: nameField }))
    .min(1, 'Select at least one Section')
    .max(500, 'At most 500 Sections per request')
    .refine((a) => new Set(a.map((i) => i.section_pk)).size === a.length, 'Duplicate Section in the request'),
})

const BULK_DUP = 'One or more Sections are already mapped for this Customer'

sectionCustomerRouter.post(
  '/customer/section-customers/bulk',
  canEdit,
  wrap(async (req, res) => {
    const b = bulkBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const { customer_pk, items } = b.data

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO section_customer (customer_pk, section_pk, customer_section_name)
         SELECT c.pk, s.pk, v.name
         FROM customers c
         CROSS JOIN unnest($2::bigint[], $3::text[]) AS v(section_pk, name)
         JOIN sections s ON s.pk = v.section_pk AND s.deleted_at IS NULL
         WHERE c.pk = $1 AND c.deleted_at IS NULL
         RETURNING ${RETURNING}`,
        [customer_pk, items.map((i) => i.section_pk), items.map((i) => i.customer_section_name)],
      )
      if (rows.length !== items.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ message: 'Customer or Section not found' })
      }
      await client.query('COMMIT')
      res.status(201).json({ items: rows })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (pgCode(e) === '23505') return res.status(409).json({ message: BULK_DUP })
      throw e
    } finally {
      client.release()
    }
  }),
)

/* ---------- EDIT: name only; Customer and Section are locked ---------- */
sectionCustomerRouter.patch(
  '/customer/section-customers/:pk',
  canEdit,
  wrap(async (req, res) => {
    const b = updateBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })

    const { rows } = await pool.query(
      `UPDATE section_customer
       SET customer_section_name = $1, updated_at = now()
       WHERE pk = $2
       RETURNING ${RETURNING}`,
      [b.data.customer_section_name, req.params.pk],
    )
    if (!rows[0]) return res.status(404).json({ message: 'Mapping not found' })
    res.json(rows[0])
  }),
)

/* ---------- DELETE ---------- */
sectionCustomerRouter.delete(
  '/customer/section-customers/:pk',
  canEdit,
  wrap(async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM section_customer WHERE pk = $1', [
      req.params.pk,
    ])
    if (!rowCount) return res.status(404).json({ message: 'Mapping not found' })
    res.json({ ok: true })
  }),
)