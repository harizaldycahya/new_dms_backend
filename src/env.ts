import 'dotenv/config'

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Env ${name} belum diisi`)
  return v
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: need('DATABASE_URL'),
  jwtSecret: need('JWT_SECRET'),
  ssoSharedToken: need('SSO_SHARED_TOKEN'),
  corsOrigin: need('CORS_ORIGIN'),
}