import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

export const cmCutRouter = Router()

cmCutRouter.use('/cm-cut', requireAuth)
// key menu Corrective Maintenance (harus sama dengan useMenuAccess di frontend CM Cut)
const canEdit = requireMenu('corrective-maintenance', 'edit')

cmCutRouter.param('pk', (_req, res, next, value) => {
  if (/^\d{1,18}$/.test(String(value))) return next()
  res.status(404).json({ message: 'Ticket not found' })
})

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

const pgCode = (e: unknown) => (e as { code?: string }).code

/* ---------- validasi body ---------- */
const pkStr = z.string().regex(/^\d{1,18}$/, 'Invalid reference')

const customerBody = z.object({
  customer: z.string().trim().min(1, 'Customer name is required').max(200),
  cids: z.array(z.string().trim().min(1).max(200)).default([]),
  cable_type: z.string().trim().min(1, 'Cable Type is required').max(100),
  service_impact: z.enum(['YES', 'NO'], { message: 'Service Impact must be YES or NO' }),
  section_customer: z.string().trim().max(200).default(''),
  start_time: z.string().datetime({ message: 'Start Time is invalid' }),
  issue_ticket: z.string().trim().max(200).default(''),
  customer_ticket_no: z.string().trim().max(100).default(''),
})

const assigneeBody = z.object({
  worker: z.string().trim().min(1).max(150),
  assignee_type: z.string().trim().min(1).max(50),
  service_point: z.string().trim().min(1).max(100),
})

const createBody = z.object({
  project_pk: pkStr,
  segment_pk: pkStr,
  section_pk: pkStr,
  service_points: z.array(z.string().trim().min(1).max(100)).default([]),
  impacted_customers: z.array(customerBody).default([]),
  assignees: z.array(assigneeBody).default([]),
})

/* =====================  CREATE  ===================== */
cmCutRouter.post(
  '/cm-cut/tickets',
  canEdit,
  wrap(async (req, res) => {
    const b = createBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const data = b.data

    // Start Time tidak boleh di masa depan (toleransi 1 menit)
    for (const c of data.impacted_customers) {
      if (new Date(c.start_time).getTime() > Date.now() + 60_000) {
        return res.status(400).json({ message: `${c.customer}: Start Time cannot be in the future` })
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // pastikan Project -> Segment -> Section benar-benar satu rantai dan masih aktif
      const loc = await client.query(
        `SELECT p.pk AS project_pk, p.project_id, p.name AS project_name,
                s.pk AS segment_pk, s.segment_id, s.name AS segment_name,
                x.pk AS section_pk, x.section_id, x.name AS section_name, x.route_id
         FROM sections x
         JOIN segments s ON s.pk = x.segment_pk  AND s.deleted_at IS NULL
         JOIN projects p ON p.pk = s.project_pk  AND p.deleted_at IS NULL
         WHERE x.pk = $1 AND s.pk = $2 AND p.pk = $3 AND x.deleted_at IS NULL`,
        [data.section_pk, data.segment_pk, data.project_pk],
      )
      const l = loc.rows[0]
      if (!l) {
        await client.query('ROLLBACK')
        return res.status(404).json({ message: 'Project / Segment / Section not found' })
      }

      // format: YYMMDD + CM + project_id + . + nomor urut global 4 digit, contoh 261124CMHQJBY.0001
      // nomor dari sequence (aman untuk request bersamaan), tanggal zona Jakarta
      const num = await client.query(
        `SELECT to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYMMDD') AS d,
                lpad(nextval('cm_cut_ticket_seq')::text, 4, '0') AS n`,
      )
      const ticketNo = `${num.rows[0].d}CM${l.project_id}.${num.rows[0].n}`
      const now = new Date()

      // status awal selalu 'created'
      const ins = await client.query(
        `INSERT INTO cm_cut
           (ticket_no, project_pk, segment_pk, section_pk,
            project_id, project_name, segment_id, segment_name, section_id, section_name,
            route_id, service_points, opened_at, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'created')
         RETURNING pk::int AS id, ticket_no`,
        [
          ticketNo, l.project_pk, l.segment_pk, l.section_pk,
          l.project_id, l.project_name, l.segment_id, l.segment_name, l.section_id, l.section_name,
          l.route_id, data.service_points, now, req.user!.id,
        ],
      )
      const ticket = ins.rows[0]

      for (const c of data.impacted_customers) {
        await client.query(
          `INSERT INTO cm_cut_customers
             (ticket_pk, customer_name, cids, cable_type, service_impact,
              section_customer, start_time, issue_ticket, customer_ticket_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ticket.id, c.customer, c.cids, c.cable_type, c.service_impact,
            c.section_customer, c.start_time, c.issue_ticket, c.customer_ticket_no,
          ],
        )
      }

      for (const a of data.assignees) {
        await client.query(
          `INSERT INTO cm_cut_assignees (ticket_pk, worker, assignee_type, service_point)
           VALUES ($1,$2,$3,$4)`,
          [ticket.id, a.worker, a.assignee_type, a.service_point],
        )
      }

      await client.query('COMMIT')
      res.status(201).json(ticket)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (pgCode(e) === '23505') {
        return res.status(409).json({ message: 'Ticket number already exists, please try again' })
      }
      throw e
    } finally {
      client.release()
    }
  }),
)

/* =====================  LIST  ===================== */
cmCutRouter.get(
  '/cm-cut/tickets',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT t.pk::int AS id, t.ticket_no, t.status,
              t.project_name, t.segment_name, t.section_name, t.service_points,
              t.opened_at, t.created_at,
              COALESCE((SELECT array_agg(DISTINCT c.customer_name ORDER BY c.customer_name)
                        FROM cm_cut_customers c WHERE c.ticket_pk = t.pk), '{}') AS customers,
              COALESCE((SELECT array_agg(a.worker ORDER BY a.service_point, a.worker)
                        FROM cm_cut_assignees a
                        WHERE a.ticket_pk = t.pk AND a.assignee_type <> 'SPV'), '{}') AS workers,
              (SELECT string_agg(a.worker, ', ' ORDER BY a.worker)
               FROM cm_cut_assignees a
               WHERE a.ticket_pk = t.pk AND a.assignee_type = 'SPV') AS spv
       FROM cm_cut t
       WHERE t.deleted_at IS NULL
       ORDER BY t.opened_at DESC, t.pk DESC`,
    )
    res.json({ items: rows })
  }),
)

/* =====================  DETAIL  ===================== */
cmCutRouter.get(
  '/cm-cut/tickets/:pk',
  wrap(async (req, res) => {
    const t = await pool.query(
      `SELECT pk::int AS id, ticket_no, status,
              project_pk::text, segment_pk::text, section_pk::text,
              project_id, project_name, segment_id, segment_name, section_id, section_name,
              route_id, service_points, opened_at, created_by, created_at
       FROM cm_cut WHERE pk = $1 AND deleted_at IS NULL`,
      [req.params.pk],
    )
    if (!t.rows[0]) return res.status(404).json({ message: 'Ticket not found' })

    const [customers, assignees] = await Promise.all([
      pool.query(
        `SELECT pk::int AS id, customer_name AS customer, cids, cable_type, service_impact,
                section_customer, start_time, issue_ticket, customer_ticket_no
         FROM cm_cut_customers WHERE ticket_pk = $1 ORDER BY customer_name`,
        [req.params.pk],
      ),
      pool.query(
        `SELECT pk::int AS id, worker, assignee_type, service_point
         FROM cm_cut_assignees WHERE ticket_pk = $1 ORDER BY service_point, worker`,
        [req.params.pk],
      ),
    ])

    res.json({ ...t.rows[0], impacted_customers: customers.rows, assignees: assignees.rows })
  }),
)