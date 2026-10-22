import { app } from './app.js'
import { env } from './env.js'

app.listen(env.port, () => console.log(`DMS API jalan di http://localhost:${env.port}`))