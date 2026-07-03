import { defineModule } from "@/define";
import purgeCommand from "./commands/purge";
import { noteCommand, noteDelCommand, notesCommand } from "./commands/note";
import { rolCreateCommand, rolDeleteCommand, rolInfoCommand, rolAddUserCommand, rolRemoveUserCommand } from "./commands/role";

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS mod_notes (
		id           SERIAL,
		user_id      VARCHAR(20) NOT NULL,
		guild_id     VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
		moderator_id VARCHAR(20) NOT NULL,
		content      TEXT NOT NULL,
		created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		PRIMARY KEY (id)
	);

	CREATE INDEX IF NOT EXISTS mod_notes_user_guild
		ON mod_notes (user_id, guild_id);
`;

export default defineModule({
    name: "moderation",
    description: "Moderation related commands",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    migrations: [SCHEMA],
    commands: [
        purgeCommand,
        noteCommand,
        noteDelCommand,
        notesCommand,
        rolCreateCommand,
        rolDeleteCommand,
        rolInfoCommand,
        rolAddUserCommand,
        rolRemoveUserCommand,
    ],
});
