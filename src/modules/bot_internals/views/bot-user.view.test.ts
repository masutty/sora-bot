import { expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
import type { BotNoteRow, BotPunishmentRow } from "@/database/bot-moderation.repository";
import { type AccountInfo, buildAccountContainer, buildNotesContainer, buildPunishmentsContainer } from "./bot-user.view";

const json = (c: ContainerBuilder) => JSON.stringify(c.toJSON());
const at = new Date("2026-10-02T12:00:00Z");
const epoch = at.getTime() / 1000;

const account: AccountInfo = {
    id: "111",
    username: "masutty",
    displayName: "Masutty",
    avatarUrl: "https://cdn.discordapp.com/avatars/111/a.png",
    createdAt: at,
    bot: false,
    mutualServers: 3,
};

test("buildAccountContainer: who they are, when the account was made, mutual servers and ban state", () => {
    const out = json(buildAccountContainer(account, null));
    expect(out).toContain("Masutty");
    expect(out).toContain("@masutty");
    expect(out).toContain("`111`");
    expect(out).toContain(`<t:${epoch}:R>`);
    expect(out).toContain("Mutual servers: **3**");
    expect(out).toContain("Not banned");
    expect(json(buildAccountContainer(account, { reason: "Spam", banned_by: "o1", created_at: at }))).toContain("Banned");
});

const punishment = (overrides: Partial<BotPunishmentRow>): BotPunishmentRow => ({
    id: 1,
    discord_user_id: "111",
    action: "ban",
    reason: null,
    by_user_id: "o1",
    created_at: at,
    ...overrides,
});

test("buildPunishmentsContainer: current state on top, then the history newest first", () => {
    const out = json(
        buildPunishmentsContainer({ reason: "Fake finds", banned_by: "o1", created_at: at }, [
            punishment({ id: 2, action: "ban", reason: "Fake finds" }),
            punishment({ id: 1, action: "unban" }),
        ]),
    );
    expect(out).toContain("**Banned** since");
    expect(out).toContain("Reason: Fake finds");
    expect(out).toContain("**Ban** by <@o1> - Fake finds");
    expect(out).toContain("**Unban** by <@o1>");
});

test("buildPunishmentsContainer: a clean record says so", () => {
    const out = json(buildPunishmentsContainer(null, []));
    expect(out).toContain("Not banned");
    expect(out).toContain("No punishments.");
});

test("buildNotesContainer: each note with its id, author and time; none says so", () => {
    const note: BotNoteRow = { id: 7, discord_user_id: "111", note: "Asked about the Network", author_id: "o1", created_at: at };
    const out = json(buildNotesContainer("111", [note]));
    expect(out).toContain("`#7`");
    expect(out).toContain("<@o1>");
    expect(out).toContain("Asked about the Network");
    expect(json(buildNotesContainer("111", []))).toContain("No notes.");
});
