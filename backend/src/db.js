import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await fn(client);
    await client.query("COMMIT");
    return res;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

