import type { NextFunction, Request, Response } from 'express'
import { pool } from '../db.js'
import { MENUS, MENU_BY_KEY, type MenuKey } from '../modules/access/menus.js'

export type Access = {
  user: { id: number; username: string; name: string | null; role: string }
  menus: Record<string, { edit: boolean }>
}

// dibaca langsung dari database, jadi perubahan role langsung berlaku
export async function getAccess(userId: number): Promise<Access | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.name, u.active,
            r.name AS role_name, r.is_system, rm.menu_key, rm.can_edit
     FROM users u
     LEFT JOIN roles r ON r.pk = u.role_pk AND r.deleted_at IS NULL
     LEFT JOIN role_menus rm ON rm.role_pk = r.pk
     WHERE u.id = $1`,
    [userId],
  )
  const first = rows[0]
  if (!first || !first.active) return null

  const menus: Access['menus'] = {}
  if (first.is_system) {
    for (const m of MENUS) menus[m.key] = { edit: m.hasEdit }
  } else {
    for (const r of rows) {
      const def = r.menu_key ? MENU_BY_KEY.get(r.menu_key) : undefined
      if (def && !def.superOnly) menus[def.key] = { edit: def.hasEdit && !!r.can_edit }
    }
  }
  return {
    user: { id: first.id, username: first.username, name: first.name, role: first.role_name ?? '' },
    menus,
  }
}

export function requireMenu(key: MenuKey, need: 'view' | 'edit' = 'view') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = req.user ? await getAccess(req.user.id) : null
      if (!access) return res.status(401).json({ message: 'Sesi tidak valid, silakan login ulang' })
      const m = access.menus[key]
      if (!m || (need === 'edit' && !m.edit)) return res.status(403).json({ message: 'Akses ditolak' })
      next()
    } catch (e) {
      next(e)
    }
  }
}
