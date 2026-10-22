import express from 'express'
import cors from 'cors'
import { env } from './env.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { cableRouter } from './modules/cable/cable.routes.js'

export const app = express()

app.use(cors({ origin: env.corsOrigin }))
app.use(express.json({ limit: '1mb' }))
app.use(authRouter)
app.use(cableRouter)

app.get('/health', (_req, res) => res.json({ ok: true }))
app.use(authRouter)

// penangan error terakhir
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ message: 'Terjadi kesalahan pada server' })
})