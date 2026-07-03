import {
	Pool,
	type PoolClient,
	type QueryResult,
	type QueryResultRow,
} from "pg";
import { Logger } from "@/utils/logging";
import { config } from "../config";

const logger = new Logger("Core.Database");

// ─── Pool singleton ───────────────────────────────────────────────────────────
// Pool é thread-safe e gerencia conexões automaticamente.
// Usamos pg diretamente (sem ORM) para controle total sobre queries.

let pool: Pool;

export function getPool(): Pool {
	if (!pool) {
		pool = new Pool({
			connectionString: config.database.url,
			max: config.database.poolMax,
			idleTimeoutMillis: config.database.poolIdleTimeout,
			// SSL automático em produção
			ssl:
				config.bot.env === "production"
					? { rejectUnauthorized: false }
					: undefined,
		});

		pool.on("error", (err) => {
			logger.error(err);
		});
	}
	return pool;
}

// ─── Query abstraction ────────────────────────────────────────────────────────
// Interface simples: query() para operações comuns, transaction() para atomicidade.

/**
 * Executa uma query parametrizada.
 * Usa $1, $2... para params (proteção nativa contra SQL injection).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
	sql: string,
	params?: unknown[],
): Promise<QueryResult<T>> {
	const pool = getPool();
	return pool.query<T>(sql, params);
}

/**
 * Executa múltiplas queries em uma transação atômica.
 * Em caso de erro, faz rollback automático.
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
 * Testa a conexão com o banco. Chamado no bootstrap.
 */
export async function testConnection(): Promise<void> {
	const result = await query<{ now: Date }>("SELECT NOW() as now");
	logger.info(`Connected. Server time: ${result.rows[0].now}`);
}

/**
 * Fecha o pool graciosamente (para testes / shutdown).
 */
export async function closePool(): Promise<void> {
	if (pool) await pool.end();
}
