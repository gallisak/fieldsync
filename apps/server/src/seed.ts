import type { Pool } from 'pg';

export const DEMO = {
  siteA: '00000000-0000-4000-8000-0000000000a1',
  siteB: '00000000-0000-4000-8000-0000000000b1',
  admin: '00000000-0000-4000-8000-000000000001',
  techA: '00000000-0000-4000-8000-000000000002',
  techB: '00000000-0000-4000-8000-000000000003',
};

export async function seedDemo(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO sites (id, name) VALUES ($1, 'North Plant'), ($2, 'South Plant') ON CONFLICT DO NOTHING`,
    [DEMO.siteA, DEMO.siteB],
  );
  await pool.query(
    `INSERT INTO users (id, name, role, token) VALUES
       ($1, 'Alice (admin)', 'admin', 'admin-token'),
       ($2, 'Tom (North Plant)', 'technician', 'tech-a-token'),
       ($3, 'Sara (South Plant)', 'technician', 'tech-b-token')
     ON CONFLICT DO NOTHING`,
    [DEMO.admin, DEMO.techA, DEMO.techB],
  );
  await pool.query(
    `INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING`,
    [DEMO.techA, DEMO.siteA, DEMO.techB, DEMO.siteB],
  );
}
