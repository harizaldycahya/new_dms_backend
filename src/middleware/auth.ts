import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../env.js'

export type AuthUser = { id: number; username: string; name: string | null; role: string }

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  try {
    req.user = jwt.verify(token, env.jwtSecret) as AuthUser
    next()
  } catch {
    res.status(401).json({ message: 'Sesi tidak valid, silakan login ulang' })
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Akses ditolak' })
    }
    next()
  }
}