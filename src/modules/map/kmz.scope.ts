import { pool } from '../../db.js'

export type Level = 'project' | 'segment' | 'section'
export type Target = { level: Level; pk: string }

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } // eslint-disable-line @typescript-eslint/no-explicit-any

export const MAX_TARGETS = 1000
const PK = /^\d{1,18}$/

export class ScopeError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Scope = {
  project: { pk: string; id: string; name: string }
  /** semua Section yang tercakup, urut Segment lalu Section */
  sections: { pk: string; id: string; name: string; segment_pk: string; segment_id: string; segment_name: string }[]
  /** true bila ada Project yang dipilih langsung (seluruh Project) */
  wholeProject: boolean
  /** teks yang harus diketik user untuk konfirmasi hapus */
  confirmText: string
}

export function parseTargets(raw: unknown): Target[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ScopeError(400, 'Select at least one item')
  if (raw.length > MAX_TARGETS) throw new ScopeError(400, `Too many items selected (max ${MAX_TARGETS})`)
  const seen = new Set<string>()
  const out: Target[] = []
  for (const t of raw) {
    const o = t as { level?: unknown; pk?: unknown } | null
    const level = o?.level
    const pk = String(o?.pk ?? '')
    if ((level !== 'project' && level !== 'segment' && level !== 'section') || !PK.test(pk)) {
      throw new ScopeError(400, 'Invalid selection')
    }
    const k = `${level}:${pk}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ level, pk })
  }
  return out
}

export async function resolveScope(db: Db, targets: Target[]): Promise<Scope> {
  const pick = (l: Level) => targets.filter((t) => t.level === l).map((t) => t.pk)
  const pp = pick('project')
  const sp = pick('segment')
  const xp = pick('section')

  const { rows: projs } = await db.query(
    'SELECT pk::text AS pk, project_id, name FROM projects WHERE pk = ANY($1::bigint[]) AND deleted_at IS NULL',
    [pp],
  )
  if (projs.length !== pp.length) throw new ScopeError(404, 'Project not found')

  const { rows: segs } = await db.query(
    'SELECT pk::text AS pk, project_pk::text AS project_pk, segment_id FROM segments WHERE pk = ANY($1::bigint[]) AND deleted_at IS NULL',
    [sp],
  )
  if (segs.length !== sp.length) throw new ScopeError(404, 'Segment not found')

  const { rows: secs } = await db.query(
    `SELECT x.pk::text AS pk, x.section_id, x.name, x.segment_pk::text AS segment_pk,
            s.segment_id, s.name AS segment_name, s.project_pk::text AS project_pk
       FROM sections x
       JOIN segments s ON s.pk = x.segment_pk
      WHERE x.deleted_at IS NULL AND s.deleted_at IS NULL
        AND (s.project_pk = ANY($1::bigint[]) OR x.segment_pk = ANY($2::bigint[]) OR x.pk = ANY($3::bigint[]))
      ORDER BY s.segment_id, x.section_id`,
    [pp, sp, xp],
  )
  const found = new Set(secs.map((r) => r.pk as string))
  if (xp.some((p) => !found.has(p))) throw new ScopeError(404, 'Section not found')

  // semua target harus berada di satu Project
  const projectPks = new Set<string>([
    ...projs.map((r) => r.pk as string),
    ...segs.map((r) => r.project_pk as string),
    ...secs.map((r) => r.project_pk as string),
  ])
  if (projectPks.size !== 1) throw new ScopeError(400, 'Select items from one Project only')
  const projectPk = [...projectPks][0]

  const { rows: pr } = await db.query(
    'SELECT pk::text AS pk, project_id, name FROM projects WHERE pk = $1 AND deleted_at IS NULL',
    [projectPk],
  )
  if (!pr[0]) throw new ScopeError(404, 'Project not found')
  const project = { pk: pr[0].pk as string, id: pr[0].project_id as string, name: pr[0].name as string }

  let confirmText = project.id
  if (targets.length === 1) {
    const t = targets[0]
    if (t.level === 'segment') confirmText = segs[0].segment_id as string
    else if (t.level === 'section') confirmText = secs.find((r) => r.pk === t.pk)!.section_id as string
  }

  return {
    project,
    sections: secs.map((r) => ({
      pk: r.pk as string,
      id: r.section_id as string,
      name: r.name as string,
      segment_pk: r.segment_pk as string,
      segment_id: r.segment_id as string,
      segment_name: r.segment_name as string,
    })),
    wholeProject: pp.length > 0,
    confirmText,
  }
}

export { pool }