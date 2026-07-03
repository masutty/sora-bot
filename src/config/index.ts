import "dotenv/config";

function require_env(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env var: ${key}`);
	return val;
}

export const config = {
	discord: {
		token: require_env("DISCORD_TOKEN"),
		clientId: require_env("DISCORD_CLIENT_ID"),
	},
	database: {
		url: require_env("DATABASE_URL"),
		// Pool sizing: regra prática = (núcleos * 2) + 1
		poolMax: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
		poolIdleTimeout: 30_000,
	},
	bot: {
		defaultPrefix: process.env.DEFAULT_PREFIX ?? "!",
		defaultCommandCategory: "General",
		env: process.env.NODE_ENV ?? "development",
		ownerIds:
			process.env.OWNER_IDS?.split(",")
				.map((id) => id.trim())
				.filter(Boolean) ?? [],
	},
} as const;

export type Config = typeof config;
