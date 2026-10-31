import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || '53cur3@kevin';
const DB_NAME = process.env.DB_NAME || 'simcard_stock';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export const dbConfig: DatabaseConfig = {
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
};

// Create connection pool
export const pool = new Pool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Helper function to run a query
export async function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    return await client.query<T>(text, params);
  } finally {
    client.release();
  }
}

// Helper function to run a transaction
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Helper function to call an RPC function
export async function callRpc<T extends QueryResultRow = any>(
  functionName: string,
  args: Record<string, any>
): Promise<T> {
  const argNames = Object.keys(args);
  const argValues = Object.values(args);
  const placeholders = argNames.map((_, i) => `$${i + 1}`).join(', ');
  
  const queryText = `SELECT * FROM ${functionName}(${placeholders})`;
  const result = await query<T>(queryText, argValues);
  return result.rows[0];
}

// Test database connection
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT NOW()');
    console.log('Database connected successfully at:', result.rows[0]?.now);
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}
