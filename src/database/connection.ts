import {
	Pool,
	type PoolClient,
	type QueryResult,
	type QueryResultRow,
} from "pg";
import { Logger } from "@/utils/logging";
import { config } from "../config";

const logger = new Logger("core.database");

// ─── Pool singleton ───────────────────────────────────────────────────────────
// Pool is thread-safe and manages connections automatically.
// We use pg directly (no ORM) for full control over queries.

let pool: Pool;

export function getPool(): Pool {
	if (!pool) {
		pool = new Pool({
			host: config.database.host,
			port: config.database.port,
			database: config.database.database,
			user: config.database.user,
			password: config.database.password,
			max: config.database.poolMax,
			idleTimeoutMillis: config.database.poolIdleTimeout,
			ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
		});

		pool.on("error", (err) => {
			logger.error(err);
		});
	}
	return pool;
}

// ─── Query abstraction ────────────────────────────────────────────────────────
// Simple interface: query() for common operations, transaction() for atomicity.

/**
 * Runs a parameterized query.
 * Uses $1, $2... for params (native protection against SQL injection).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
	sql: string,
	params?: unknown[],
): Promise<QueryResult<T>> {
	const pool = getPool();
	return pool.query<T>(sql, params);
}

/**
 * Runs multiple queries in an atomic transaction.
 * Rolls back automatically on error.
 */
export async function transaction<T>(
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const pool = getPool();
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

/**
 * Tests the database connection. Called during bootstrap.
 */
export async function testConnection(): Promise<void> {
	const result = await query<{ now: Date }>("SELECT NOW() as now");
	logger.info(`Connected. Server time: ${result.rows[0].now}`);
}

/**
 * Closes the pool gracefully (for tests / shutdown).
 */
export async function closePool(): Promise<void> {
	if (pool) await pool.end();
}

export interface PoolStats {
	total: number;
	idle: number;
	waiting: number;
}

/** Snapshot of connection pool saturation - a non-zero `waiting` means queries are queueing for a free connection, a clear scale-up signal. */
export function getPoolStats(): PoolStats {
	const p = getPool();
	return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
}
