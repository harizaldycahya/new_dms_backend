import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../../db.js'
import { requireAuth } from '../../middleware/auth.js'
import { requireMenu } from '../../middleware/access.js'

export const coreRouter = Router()

coreRouter.use('/cable', requireAuth)
const canEdit = requireMenu('master-cable', 'edit')

coreRouter.param('sectionPk', (_req, res, next, value) => {
  if (/^\d{1,18}$/.test(String(value))) return next()
  res.status(404).json({ message: 'Item not found' })
})

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

// z.coerce.string keeps "007" as "007" (never convert these to numbers)
// max(3) matches the varchar(3) columns: a longer value is counted as `invalid`
// instead of making the whole insert fail with "value too long"
const str = z.coerce.string().trim().min(1).max(3)
const coreRow = z.object({
  project_id: str,
  route_id: z.coerce.number().int(),
  segment_id: str,
  section_id: str,
  customer_id: str,
  core: str,
})
const payload = z.object({
  data: z.array(z.unknown()),
  // Laravel paginator info; if it is missing we treat the response as a single page
  meta: z.object({ last_page: z.coerce.number().int().min(1) }).optional(),
})

const PER_PAGE = 5000 // the CMS caps per_page at 5000
const MAX_PAGES = 200 // safety stop: 200 x 5000 = 1,000,000 rows

// fetch one page of the CMS API
async function fetchCmsPage(base: string, page: number) {
  let u: URL
  try {
    u = new URL(base)
  } catch {
    throw new SyncError(500, 'CMS_API_URL is not a valid URL')
  }
  u.searchParams.set('per_page', String(PER_PAGE))
  u.searchParams.set('page', String(page))

  let json: unknown
  try {
    const r = await fetch(u, {
      headers: process.env.CMS_API_TOKEN
        ? { Authorization: `Bearer ${process.env.CMS_API_TOKEN}` }
        : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) throw new SyncError(502, `CMS API responded ${r.status}`)
    json = await r.json()
  } catch (e) {
    if (e instanceof SyncError) throw e
    throw new SyncError(502, 'Could not reach the CMS API')
  }

  const p = payload.safeParse(json)
  if (!p.success) throw new SyncError(502, 'Unexpected response from the CMS API')
  return p.data
}

export class SyncError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export type CoreSyncResult = {
  received: number
  invalid: number
  inserted: number
  existing: number
  unmatched: number
}

/* ---------- list core of one Section ----------
   A core belongs to a Section through the real IDs, not through a pk:
   project_id + segment_id + section_id + route_id. The chain is built from
   the Section that was clicked, so IDs that repeat under other parents
   never mix. */
coreRouter.get(
  '/cable/sections/:sectionPk/cores',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.pk, c.customer_id, c.core, c.synced_at
       FROM sections x
       JOIN segments s ON s.pk = x.segment_pk AND s.deleted_at IS NULL
       JOIN projects p ON p.pk = s.project_pk AND p.deleted_at IS NULL
       JOIN core c ON c.project_id = p.project_id
                  AND c.segment_id = s.segment_id
                  AND c.section_id = x.section_id
                  AND c.route_id   = x.route_id
       WHERE x.pk = $1 AND x.deleted_at IS NULL
       ORDER BY NULLIF(regexp_replace(c.core, '\\D', '', 'g'), '')::numeric NULLS LAST,
                c.core,
                NULLIF(regexp_replace(c.customer_id, '\\D', '', 'g'), '')::numeric NULLS LAST,
                c.customer_id`,
      [req.params.sectionPk],
    )
    res.json({ items: rows })
  }),
)

/* ---------- sync core from the CMS API ----------
   Exported so the parent sync (Project/Segment/Section) can call it.
   Every valid row is stored with its own IDs, so it no longer depends on the
   parent existing at that moment (core can arrive before its Section).
   `unmatched` = rows stored but with no active Project/Segment/Section/Route
   combination in the master yet (informational, nothing is skipped). */
export async function runCoreSync(): Promise<CoreSyncResult> {
  const url = process.env.CMS_API_URL
  if (!url) throw new SyncError(500, 'CMS_API_URL is not configured')

  // the CMS API is paginated: read every page, not only the first one
  const all: unknown[] = []
  let lastPage = 1
  for (let page = 1; page <= lastPage; page++) {
    const res = await fetchCmsPage(url, page)
    all.push(...res.data)
    lastPage = res.meta?.last_page ?? 1
    if (lastPage > MAX_PAGES) throw new SyncError(502, 'CMS API returned too many pages')
  }

  // validate row by row: one bad row must not block the rest; dedupe identical rows
  const unique = new Map<string, z.infer<typeof coreRow>>()
  let invalid = 0
  for (const raw of all) {
    const r = coreRow.safeParse(raw)
    if (!r.success) {
      invalid++
      continue
    }
    const d = r.data
    unique.set(
      [d.project_id, d.route_id, d.segment_id, d.section_id, d.customer_id, d.core].join('\u0001'),
      d,
    )
  }
  const rows = [...unique.values()]

  const { rows: out } = await pool.query(
    `WITH src AS (
       SELECT * FROM unnest($1::varchar[], $2::int[], $3::varchar[], $4::varchar[], $5::varchar[], $6::varchar[])
         AS t(project_id, route_id, segment_id, section_id, customer_id, core)
     ),
     ins AS (
       INSERT INTO core (project_id, route_id, segment_id, section_id, customer_id, core)
       SELECT project_id, route_id, segment_id, section_id, customer_id, core FROM src
       ON CONFLICT (project_id, route_id, segment_id, section_id, customer_id, core)
       DO UPDATE SET synced_at = now()
       RETURNING (xmax = 0) AS inserted
     )
     SELECT count(*) FILTER (WHERE inserted)::int     AS inserted,
            count(*) FILTER (WHERE NOT inserted)::int AS existing,
            (SELECT count(*)
               FROM src t
              WHERE NOT EXISTS (
                SELECT 1
                FROM sections x
                JOIN segments s ON s.pk = x.segment_pk AND s.deleted_at IS NULL
                JOIN projects p ON p.pk = s.project_pk AND p.deleted_at IS NULL
                WHERE x.deleted_at IS NULL
                  AND p.project_id = t.project_id
                  AND s.segment_id = t.segment_id
                  AND x.section_id = t.section_id
                  AND x.route_id   = t.route_id
              ))::int AS unmatched
     FROM ins`,
    [
      rows.map((r) => r.project_id),
      rows.map((r) => r.route_id),
      rows.map((r) => r.segment_id),
      rows.map((r) => r.section_id),
      rows.map((r) => r.customer_id),
      rows.map((r) => r.core),
    ],
  )

  const { inserted, existing, unmatched } = out[0]
  return {
    received: all.length,
    invalid,
    inserted,
    existing,
    unmatched,
  }
}

// kept as a standalone endpoint (core only), handy for debugging
coreRouter.post(
  '/cable/cores/sync',
  canEdit,
  wrap(async (_req, res) => {
    try {
      res.json(await runCoreSync())
    } catch (e) {
      if (e instanceof SyncError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  }),
)