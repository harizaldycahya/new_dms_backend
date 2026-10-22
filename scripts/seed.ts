import bcrypt from 'bcryptjs'
import { pool } from '../src/db.js'

const hash = await bcrypt.hash('admin123', 10)
await pool.query(
  `INSERT INTO users (username, name, password_hash, role)
   VALUES ('admin', 'Admin HO', $1, 'ADMIN')
   ON CONFLICT (username) DO NOTHING`,
  [hash],
)
console.log('User admin dibuat: admin / admin123 (ganti sebelum produksi)')
await pool.end()