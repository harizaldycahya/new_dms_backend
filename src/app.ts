import express from 'express'
import cors from 'cors'
import { env } from './env.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { cableRouter } from './modules/cable/cable.routes.js'
import { coreRouter } from './modules/core/cores.routes.js'
import { mapRouter } from './modules/map/kmz.routes.js'
import { accessRouter } from './modules/access/access.routes.js'
import { mapDataRouter } from './modules/map/map.routes.js'
import { portalRouter } from './modules/portal/portal.routes.js'
import { soRouter } from './modules/so/so.routes.js'
import { customerRouter } from './modules/customer/customer.routes.js'
import { sectionCustomerRouter } from './modules/customer/sectionCustomer.routes.js'
import { cmCutRouter } from './modules/cm-cut/cm-cut.routes.js'
import { serpoSectionRouter } from './modules/serpo-section/serpoSection.routes.js'
import { rootCauseRouter } from './modules/master-ticket/rootCause.routes.js'

export const app = express()

app.use(cors({ origin: env.corsOrigin }))
app.use(express.json({ limit: '1mb' }))

app.use(authRouter)
app.use(cableRouter)
app.use(coreRouter)
app.use(mapRouter)
app.use(accessRouter)
app.use(soRouter)
app.use(mapDataRouter)
app.use(customerRouter)
app.use(sectionCustomerRouter)
app.use(portalRouter)
app.use(cmCutRouter)
app.use(soRouter)
app.use(serpoSectionRouter)
app.use(mapDataRouter)
app.use(rootCauseRouter)

app.get('/health', (_req, res) => res.json({ ok: true }))

// penangan error terakhir
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ message: 'Terjadi kesalahan pada server' })
})