# Discord Bot Framework

Framework modular para Discord bots em TypeScript.

## Estrutura

```
src/
├── index.ts                  # Bootstrap: banco → módulos → handlers → login
├── config/
│   └── index.ts              # Lê .env e valida variáveis obrigatórias
├── types/
│   └── index.ts              # Interfaces compartilhadas (CommandDefinition, ModuleDefinition, etc.)
├── database/
│   ├── connection.ts         # Pool pg + query() + transaction()
│   ├── guildRepository.ts    # CRUD de guilds + cache de prefix
│   └── migrate.ts            # Runner de migrações idempotentes
├── core/
│   ├── BotClient.ts          # Extends Client do discord.js, injeta CommandRegistry
│   ├── CommandRegistry.ts    # Map<name, CommandDefinition> com lookup O(1)
│   ├── CommandHandler.ts     # Listeners messageCreate + interactionCreate
│   └── ModuleLoader.ts       # Discovery de módulos por filesystem
├── commands/                 # Comandos built-in
│   ├── ping.ts
│   ├── help.ts
│   ├── echo.ts
│   └── setprefix.ts
└── modules/                  # Cada pasta = um módulo
    └── example/
        └── index.ts          # default export: ModuleDefinition
```

## Setup

```bash
cp .env.example .env
# Preencha DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL

npm install
npm run db:migrate
npm run dev
```

## Adicionar um comando built-in

```typescript
// src/commands/ban.ts
import { CommandDefinition } from '../types';

const ban: CommandDefinition = {
  name: 'ban',
  description: 'Bane um usuário.',
  category: 'Moderação',
  args: [{ name: 'user', description: 'Usuário', type: 'user', required: true }],

  async executeSlash(interaction, client) { /* ... */ },
  async executePrefix(message, args, client) { /* ... */ },
};

export default ban;
```

Depois registre em `src/index.ts`:
```typescript
import banCommand from './commands/ban';
client.commands.set(banCommand.name, banCommand);
```

## Adicionar um módulo

```typescript
// src/modules/economia/index.ts
import { ModuleDefinition } from '../../types';

const EconomiaModule: ModuleDefinition = {
  name: 'economia',
  description: 'Sistema de moedas por servidor.',

  migrations: [`
    CREATE TABLE IF NOT EXISTS economy_wallets (
      guild_id VARCHAR(20) REFERENCES guilds(id) ON DELETE CASCADE,
      user_id  VARCHAR(20) NOT NULL,
      balance  BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
  `],

  commands: [
    {
      name: 'balance',
      description: 'Vê seu saldo.',
      category: 'Economia',
      async executeSlash(interaction) { /* ... */ },
      async executePrefix(message) { /* ... */ },
    },
  ],

  events: [
    {
      event: 'messageCreate',
      async handler(client, message) {
        // Dá coins por mensagem, por exemplo
      },
    },
  ],
};

export default EconomiaModule;
```

O ModuleLoader detecta e carrega automaticamente. Sem registro manual.

## Decisões de arquitetura

| Decisão | Motivo |
|---|---|
| `discord.js` estendido via herança | Mantém o EventEmitter e tipagens nativas |
| Map no CommandRegistry | Lookup O(1) — executado a cada mensagem |
| `pg` sem ORM | Controle total sobre queries, sem overhead, schema flexível com JSONB |
| Discovery por filesystem | Adicionar módulo = criar pasta. Zero boilerplate |
| Cache de prefix em memória | Evita query ao banco a cada mensagem (TTL 5min) |
| `transaction()` wrapper | Rollback automático — nunca esquecer de tratar erro |
| Migrações idempotentes | Tabela `_migrations` rastreia o que já foi aplicado |
