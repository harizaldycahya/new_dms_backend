import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { pool, ScopeError, parseTargets, resolveScope, type Target } from './kmz.scope.js'

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void

const fail = (res: Response, e: unknown) => {
  if (e instanceof ScopeError) return res.status(e.status).json({ message: e.message })
  throw e
}

type Counts = { points: number; lines: number; polygons: number; total: number; sections_with_data: number }

async function countFeatures(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, // eslint-disable-line @typescript-eslint/no-explicit-any
  sectionPks: string[],
): Promise<Counts> {
  if (sectionPks.length === 0) return { points: 0, lines: 0, polygons: 0, total: 0, sections_with_data: 0 }
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE geom_type = 'Point')::int      AS points,
            count(*) FILTER (WHERE geom_type = 'LineString')::int AS lines,
            count(*) FILTER (WHERE geom_type = 'Polygon')::int    AS polygons,
            count(DISTINCT section_pk)::int                       AS sections_with_data
       FROM map_features
      WHERE section_pk = ANY($1::bigint[]) AND replaced_at IS NULL`,
    [sectionPks],
  )
  const r = rows[0]
  return { points: r.points, lines: r.lines, polygons: r.polygons, total: r.points + r.lines + r.polygons, sections_with_data: r.sections_with_data }
}

/** Soft-delete: fitur aktif diberi replaced_at, riwayat tetap ada. Dicatat di kmz_uploads. */
async function performDelete(targets: Target[], confirm: string, userId: unknown) {
  // dipakai hanya untuk mengetahui Project mana yang harus di-lock
  const first = await resolveScope(pool, targets)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // sama dengan confirm upload: satu operasi per Project dalam satu waktu
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [first.project.pk])

    // petakan ulang di dalam transaksi
    const scope = await resolveScope(client, targets)
    if (confirm.trim().toLowerCase() !== scope.confirmText.toLowerCase()) {
      throw new ScopeError(400, 'The confirmation does not match')
    }

    const sectionPks = scope.sections.map((s) => s.pk)
    const counts = await countFeatures(client, sectionPks)
    if (counts.total === 0) throw new ScopeError(409, 'There is no map data to delete in the selection')

    const { rows: up } = await client.query(
      `INSERT INTO kmz_uploads (project_pk, filename, size_bytes, uploaded_by)
       VALUES ($1, $2, 0, $3) RETURNING pk`,
      [scope.project.pk, '(map data deleted)', userId],
    )
    const uploadPk = up[0].pk as string

    const { rowCount } = await client.query(
      `UPDATE map_features SET replaced_at = now(), replaced_by_upload = $2
        WHERE section_pk = ANY($1::bigint[]) AND replaced_at IS NULL`,
      [sectionPks, uploadPk],
    )

    const summary = {
      action: 'delete',
      targets,
      sections: sectionPks.length,
      sections_cleared: counts.sections_with_data,
      features_removed: rowCount ?? 0,
    }
    await client.query('UPDATE kmz_uploads SET summary = $2::jsonb WHERE pk = $1', [uploadPk, JSON.stringify(summary)])
    await client.query('COMMIT')

    return { ok: true, upload_pk: uploadPk, features_removed: rowCount ?? 0, sections_cleared: counts.sections_with_data }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

export function registerDeleteMapData(router: Router, canEdit: RequestHandler, wrap: Wrap) {
  /**
   * POST /map/data/impact   body: { targets }
   * Dampak penghapusan, untuk ditampilkan sebelum user mengonfirmasi.
   */
  router.post(
    '/map/data/impact',
    canEdit,
    wrap(async (req, res) => {
      try {
        const scope = await resolveScope(pool, parseTargets(req.body?.targets))
        const counts = await countFeatures(pool, scope.sections.map((s) => s.pk))
        res.json({
          project: scope.project,
          whole_project: scope.wholeProject,
          confirm_text: scope.confirmText,
          sections: scope.sections.length,
          ...counts,
        })
      } catch (e) {
        return fail(res, e)
      }
    }),
  )

  /**
   * DELETE /map/data   body: { targets, confirm }
   */
  router.delete(
    '/map/data',
    canEdit,
    wrap(async (req, res) => {
      try {
        const targets = parseTargets(req.body?.targets)
        const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : ''
        res.json(await performDelete(targets, confirm, req.user!.id))
      } catch (e) {
        return fail(res, e)
      }
    }),
  )

}