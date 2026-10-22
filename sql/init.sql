CREATE EXTENSION IF NOT EXISTS postgis;

-- master role
CREATE TABLE IF NOT EXISTS roles (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'WEB' CHECK (platform IN ('WEB','MOBILE','BOTH')),
  active   BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO roles (code, name, platform) VALUES
  ('ADMIN',       'Administrator', 'WEB'),
  ('ENGINEERING', 'Engineering',   'WEB'),
  ('NOC',         'NOC',           'WEB'),
  ('SPV',         'Supervisor',    'BOTH'),
  ('JOINTER',     'Jointer',       'MOBILE')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(code) ON UPDATE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- token SSO dari portal: sekali pakai, kedaluwarsa cepat
CREATE TABLE IF NOT EXISTS sso_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);