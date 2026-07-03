import { Logger } from "@/utils/logging";
import { closePool, query, testConnection } from "./connection";

const logger = new Logger("Core.Database");

// ─── Schema Base ──────────────────────────────────────────────────────────────

const BASE_SCHEMA = `
-- Tabela de configuração por guild
CREATE TABLE IF NOT EXISTS guilds (
  id          VARCHAR(20)  PRIMARY KEY,           -- Discord snowflake ID
  prefix      VARCHAR(10)  NOT NULL DEFAULT '!',  -- Prefix customizável
  settings    JSONB        NOT NULL DEFAULT '{}', -- Dados livres por módulo
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice no JSONB para queries em settings específicas
CREATE INDEX IF NOT EXISTS idx_guilds_settings ON guilds USING gin(settings);

-- Tabela de tracking de migrações (evita re-executar)
CREATE TABLE IF NOT EXISTS _migrations (
  name       VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * Registra e executa uma migração de forma idempotente.
 */
async function runMigration(name: string, sql: string): Promise<void> {
	const check = await query(`SELECT 1 FROM _migrations WHERE name = $1`, [
		name,
	]);

	if (check.rowCount && check.rowCount > 0) {
		logger.debug(`Migration already applied: ${name}`);
		return;
	}

	await query(sql);
	await query(`INSERT INTO _migrations (name) VALUES ($1)`, [name]);
	logger.info(`Migration applied: ${name}`);
}

/**
 * Ponto de entrada para migrações adicionais (módulos podem chamar isso).
 */
export async function runModuleMigrations(
	moduleName: string,
	migrations: string[],
): Promise<void> {
	for (let i = 0; i < migrations.length; i++) {
		await runMigration(`${moduleName}_${i + 1}`, migrations[i]);
	}
}

/**
 * Bootstrap completo do banco.
 */
export async function migrate(): Promise<void> {
	await testConnection();

	// Schema base sempre primeiro
	await query(BASE_SCHEMA);

	// Cria tabela de migrações se não existe (bootstrap inicial)
	await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

	logger.info("Base schema ready.");
}

// ─── CLI runner ───────────────────────────────────────────────────────────────
// Permite rodar: ts-node src/database/migrate.ts

if (require.main === module) {
	migrate()
		.then(() => {
			logger.info("Migrations complete.");
			process.exit(0);
		})
		.catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			process.exit(1);
		})
		.finally(closePool);
}
