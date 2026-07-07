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
        // Independente de NODE_ENV - managed Postgres (Heroku, RDS, Supabase...) geralmente exige SSL,
        // mas um Postgres local/self-hosted (incluindo o serviço do docker-compose) geralmente não tem.
        ssl: process.env.DATABASE_SSL === "true",
    },
    bot: {
        defaultPrefix: process.env.DEFAULT_PREFIX ?? "!",
        defaultCommandCategory: "General",

        deferredPrefixCommandMessage:process.env.DEFERRED_PREFIX_COMMAND_MESSAGE ?? "Processing...",

        env: process.env.NODE_ENV ?? "development",

        ownerIds:
            process.env.OWNER_IDS?.split(",")
                .map((id) => id.trim())
                .filter(Boolean) ?? [],
    },
} as const;

export type Config = typeof config;
