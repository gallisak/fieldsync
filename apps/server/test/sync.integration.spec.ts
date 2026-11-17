import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('sync protocol (integration)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('connects to the database', async () => {
    const { rows } = await pool.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });
});
