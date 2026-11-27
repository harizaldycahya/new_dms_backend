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

// offset: true -> terima "...Z" maupun "...+07:00"
const customerBody = z.object({
  customer: z.string().trim().min(1, 'Customer name is required').max(200),
  cids: z.array(z.string().trim().min(1).max(200)).default([]),
  cable_type: z.string().trim().min(1, 'Cable Type is required').max(100),
  service_impact: z.enum(['YES', 'NO'], { message: 'Service Impact must be YES or NO' }),
  section_customer: z.string().trim().max(200).default(''),
  start_time: z.string().datetime({ offset: true, message: 'Start Time is invalid' }),
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

/* ---------- validasi update (PATCH) ---------- */
// sama dengan STATUS_EDITABLE dan LOCKED di TicketDetailPage
const EDITABLE_STATUS = ['cancelled', 'closed', 'created', 'opened', 'paused'] as const
const LOCKED_STATUS = ['closed', 'pending_approval']

const text = z.string().trim().max(2000)
const decimal = z.number().min(0, 'Number must be 0 or more').max(1_000_000_000).nullable()
const whole = z.number().int('Must be a whole number').min(0).max(1_000_000_000).nullable()

// kolom cm_cut yang boleh diubah. Nama kolom di query UPDATE hanya diambil dari sini
const detailShape = {
  status: z.enum(EDITABLE_STATUS),
  ticket_detail_category: text,
  lokasi_problem: text,
  action_taken: text,
  action_taken_description: text,
  rooted_cause_detail: text,
  rooted_cause_description: text,
  project_week: whole,
  week_number: whole,
  cable_type_core: whole,
  cable_status: text,
  length_m: decimal,
  protection_sleeve_pcs: whole,
  hdpe_m: decimal,
  protection: text,
  closure_pcs: whole,
  abd_cut_point: text,
  type_closure_core: whole,
}
const DETAIL_COLUMNS = Object.keys(detailShape) as (keyof typeof detailShape)[]

const updateBody = z
  .object({
    ...detailShape,
    // lokasi: harus dikirim bertiga, dicek lagi di handler
    project_pk: pkStr,
    segment_pk: pkStr,
    section_pk: pkStr,
    // daftar penuh pengganti
    impacted_customers: z.array(
      customerBody.extend({
        end_time: z.string().datetime({ offset: true, message: 'End Time is invalid' }).nullable().default(null),
      }),
    ),
    assignees: z.array(assigneeBody),
  })
  .partial()

type Db = Pick<typeof pool, 'query'>

/** pastikan Project -> Segment -> Section satu rantai dan masih aktif */
async function findLocation(db: Db, projectPk: string, segmentPk: string, sectionPk: string) {
  const r = await db.query(
    `SELECT p.pk AS project_pk, p.project_id, p.name AS project_name,
            s.pk AS segment_pk, s.segment_id, s.name AS segment_name,
            x.pk AS section_pk, x.section_id, x.name AS section_name, x.route_id
     FROM sections x
     JOIN segments s ON s.pk = x.segment_pk  AND s.deleted_at IS NULL
     JOIN projects p ON p.pk = s.project_pk  AND p.deleted_at IS NULL
     WHERE x.pk = $1 AND s.pk = $2 AND p.pk = $3 AND x.deleted_at IS NULL`,
    [sectionPk, segmentPk, projectPk],
  )
  return r.rows[0] ?? null
}

async function findDetail(db: Db, pk: string) {
  const t = await db.query(
    `SELECT pk::int AS id, ticket_no, status,
            project_pk::text, segment_pk::text, section_pk::text,
            project_id, project_name, segment_id, segment_name, section_id, section_name,
            route_id, service_points, opened_at, closed_at, created_by, created_at,
            ${DETAIL_COLUMNS.filter((c) => c !== 'status').join(', ')}
     FROM cm_cut WHERE pk = $1 AND deleted_at IS NULL`,
    [pk],
  )
  if (!t.rows[0]) return null

  const customers = await db.query(
    `SELECT pk::int AS id, customer_name AS customer, cids, cable_type, service_impact,
            section_customer, start_time, end_time, issue_ticket, customer_ticket_no,
            round(extract(epoch FROM end_time - start_time) / 60)::int AS mttr_min
     FROM cm_cut_customers WHERE ticket_pk = $1 ORDER BY customer_name`,
    [pk],
  )
  const assignees = await db.query(
    `SELECT pk::int AS id, worker, assignee_type, service_point
     FROM cm_cut_assignees WHERE ticket_pk = $1 ORDER BY service_point, worker`,
    [pk],
  )
  return { ...t.rows[0], impacted_customers: customers.rows, assignees: assignees.rows }
}

const hasDuplicate = (values: string[]) => new Set(values).size !== values.length

/* =====================  LOCATIONS (dropdown)  ===================== */
cmCutRouter.get(
  '/cm-cut/locations',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT p.pk::text AS project_pk, p.project_id, p.name AS project_name,
              s.pk::text AS segment_pk, s.name AS segment_name,
              x.pk::text AS section_pk, x.name AS section_name
       FROM projects p
       JOIN segments s ON s.project_pk = p.pk AND s.deleted_at IS NULL
       JOIN sections x ON x.segment_pk = s.pk AND x.deleted_at IS NULL
       WHERE p.deleted_at IS NULL
       ORDER BY p.name, s.name, x.name`,
    )
    type Sec = { pk: string; name: string }
    type Seg = { pk: string; name: string; sections: Sec[] }
    type Proj = { pk: string; project_id: string; name: string; segments: Seg[] }
    const projects = new Map<string, Proj>()
    for (const r of rows) {
      let p = projects.get(r.project_pk)
      if (!p) {
        p = { pk: r.project_pk, project_id: r.project_id, name: r.project_name, segments: [] }
        projects.set(r.project_pk, p)
      }
      let sg = p.segments.find((x) => x.pk === r.segment_pk)
      if (!sg) {
        sg = { pk: r.segment_pk, name: r.segment_name, sections: [] }
        p.segments.push(sg)
      }
      sg.sections.push({ pk: r.section_pk, name: r.section_name })
    }
    res.json({ items: [...projects.values()] })
  }),
)

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

      const l = await findLocation(client, data.project_pk, data.segment_pk, data.section_pk)
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
              t.opened_at, t.created_at, t.closed_at,
              -- MTTR ticket: Start paling awal sampai End paling akhir, hanya kalau semua customer sudah punya End Time
              (SELECT CASE WHEN count(*) > 0 AND count(c.end_time) = count(*)
                        THEN round(extract(epoch FROM max(c.end_time) - min(c.start_time)) / 60)::int END
               FROM cm_cut_customers c WHERE c.ticket_pk = t.pk) AS mttr_min,
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
    const detail = await findDetail(pool, String(req.params.pk))
    if (!detail) return res.status(404).json({ message: 'Ticket not found' })
    res.json(detail)
  }),
)

/* =====================  UPDATE  ===================== */
cmCutRouter.patch(
  '/cm-cut/tickets/:pk',
  canEdit,
  wrap(async (req, res) => {
    const b = updateBody.safeParse(req.body)
    if (!b.success) return res.status(400).json({ message: b.error.issues[0].message })
    const data = b.data
    const pk = String(req.params.pk)
    const { impacted_customers: customers, assignees } = data

    // lokasi harus dikirim bertiga
    const locSent = [data.project_pk, data.segment_pk, data.section_pk].filter((v) => v !== undefined).length
    if (locSent > 0 && locSent < 3) {
      return res.status(400).json({ message: 'Project, Segment and Section must be sent together' })
    }

    // validasi waktu (toleransi 1 menit)
    const limit = Date.now() + 60_000
    for (const c of customers ?? []) {
      const start = new Date(c.start_time).getTime()
      const end = c.end_time ? new Date(c.end_time).getTime() : null
      const fail = (msg: string) => res.status(400).json({ message: `${c.customer}: ${msg}` })
      if (start > limit) return fail('Start Time cannot be in the future')
      if (end !== null && end < start) return fail('End Time cannot be before Start Time')
      if (end !== null && end > limit) return fail('End Time cannot be in the future')
    }
    if (customers && hasDuplicate(customers.map((c) => c.customer))) {
      return res.status(400).json({ message: 'Duplicate customer' })
    }
    if (assignees && hasDuplicate(assignees.map((a) => a.worker))) {
      return res.status(400).json({ message: 'Duplicate worker' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // kunci baris ticket supaya update bersamaan tidak saling menimpa di tengah jalan
      const cur = await client.query(
        'SELECT status FROM cm_cut WHERE pk = $1 AND deleted_at IS NULL FOR UPDATE',
        [pk],
      )
      if (!cur.rows[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ message: 'Ticket not found' })
      }
      if (LOCKED_STATUS.includes(cur.rows[0].status)) {
        await client.query('ROLLBACK')
        return res.status(409).json({ message: 'Ticket is locked and cannot be changed' })
      }

      // ganti Project / Segment / Section (nomor ticket tidak berubah)
      if (data.project_pk && data.segment_pk && data.section_pk) {
        const l = await findLocation(client, data.project_pk, data.segment_pk, data.section_pk)
        if (!l) {
          await client.query('ROLLBACK')
          return res.status(400).json({ message: 'Project / Segment / Section not found or inactive' })
        }
        await client.query(
          `UPDATE cm_cut SET project_pk = $2, segment_pk = $3, section_pk = $4,
                  project_id = $5, project_name = $6, segment_id = $7, segment_name = $8,
                  section_id = $9, section_name = $10, route_id = $11
           WHERE pk = $1`,
          [
            pk, l.project_pk, l.segment_pk, l.section_pk, l.project_id, l.project_name,
            l.segment_id, l.segment_name, l.section_id, l.section_name, l.route_id,
          ],
        )
      }

      const columns = DETAIL_COLUMNS.filter((c) => data[c] !== undefined)
      if (columns.length > 0) {
        const set = columns.map((c, i) => `${c} = $${i + 2}`)
        if (data.status === 'closed') set.push('closed_at = now()')
        await client.query(`UPDATE cm_cut SET ${set.join(', ')} WHERE pk = $1`, [pk, ...columns.map((c) => data[c])])
      }

      if (customers) {
        await client.query('DELETE FROM cm_cut_customers WHERE ticket_pk = $1', [pk])
        for (const c of customers) {
          await client.query(
            `INSERT INTO cm_cut_customers
               (ticket_pk, customer_name, cids, cable_type, service_impact,
                section_customer, start_time, end_time, issue_ticket, customer_ticket_no)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              pk, c.customer, c.cids, c.cable_type, c.service_impact,
              c.section_customer, c.start_time, c.end_time, c.issue_ticket, c.customer_ticket_no,
            ],
          )
        }
      }

      if (assignees) {
        await client.query('DELETE FROM cm_cut_assignees WHERE ticket_pk = $1', [pk])
        for (const a of assignees) {
          await client.query(
            `INSERT INTO cm_cut_assignees (ticket_pk, worker, assignee_type, service_point)
             VALUES ($1,$2,$3,$4)`,
            [pk, a.worker, a.assignee_type, a.service_point],
          )
        }
        if (assignees.length > 0) {
          await client.query('UPDATE cm_cut SET service_points = $2 WHERE pk = $1', [
            pk,
            [...new Set(assignees.map((a) => a.service_point))],
          ])
        }
      }

      const detail = await findDetail(client, pk)
      await client.query('COMMIT')
      res.json(detail)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (pgCode(e) === '23514') {
        return res.status(400).json({ message: 'Value is not allowed by the database' })
      }
      throw e
    } finally {
      client.release()
    }
  }),
)