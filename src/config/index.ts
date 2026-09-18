import "dotenv/config";

function require_env(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

export const config = {
    discord: {
        token: require_env("BOT_TOKEN"),
        clientId: require_env("BOT_CLIENT_ID"),
    },
    database: {
        // Discrete fields instead of a hand-built DATABASE_URL - `pg` accepts either, and discrete
        // avoids having to deal with escaping/URL-encoding if the password has a special character.
        host: process.env.POSTGRES_HOST ?? "localhost",
        port: parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
        database: require_env("POSTGRES_DB"),
        user: process.env.POSTGRES_USER ?? "postgres",
        password: require_env("POSTGRES_PASSWORD"),
        // Pool sizing rule of thumb: (cores * 2) + 1
        poolMax: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
        poolIdleTimeout: 30_000,
        // Independent of NODE_ENV - managed Postgres (Heroku, RDS, Supabase...) usually requires
        // SSL, but a local/self-hosted Postgres (including the bundled docker-compose service)
        // usually doesn't.
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

        // Folder names under src/modules (e.g. "zabbix,autobloqueador") - these cogs are skipped
        // at boot, never even imported. Lets you disable a module without touching its code/config.
        disabledCogs:
            process.env.DISABLED_COGS?.split(",")
                .map((name) => name.trim())
                .filter(Boolean) ?? [],

        // Experimental: lets prefix commands accept an option via `--name`/`--name=value`
        // (CLI-style), in any position, in addition to the normal positional arg (see
        // PrefixArgs). Off by default until validated in real use.
        allowArgsAsFlags: process.env.DEV_ALLOW_ARGS_AS_FLAGS === "true",
    },
} as const;

export type Config = typeof config;
