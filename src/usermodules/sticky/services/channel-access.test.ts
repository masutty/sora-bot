import { expect, test } from "bun:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { accessMessage, channelAccess } from "./channel-access";

const P = PermissionFlagsBits;
const BOT_OK = [P.ViewChannel, P.SendMessages, P.ManageMessages, P.ReadMessageHistory];

function setup(type: ChannelType, userPerms: bigint[], botPerms: bigint[]) {
    const user = { id: "user" };
    const bot = { id: "bot" };
    const has = (perms: bigint[]) => ({
        has: (wanted: bigint | bigint[]) => [wanted].flat().every((p) => perms.includes(p)),
    });
    const channel = { type, permissionsFor: (m: unknown) => has(m === user ? userPerms : botPerms) };
    return { channel: channel as never, user: user as never, bot: bot as never };
}

test("a voice channel is not text", () => {
    const s = setup(ChannelType.GuildVoice, [P.ManageMessages], BOT_OK);
    expect(channelAccess(s.channel, s.user, s.bot)).toBe("not_text");
});

test("a member without ManageMessages in the channel is refused", () => {
    const s = setup(ChannelType.GuildText, [], BOT_OK);
    expect(channelAccess(s.channel, s.user, s.bot)).toBe("user_cannot_manage");
});

test("a bot without ReadMessageHistory is flagged", () => {
    const s = setup(ChannelType.GuildText, [P.ManageMessages], [P.ViewChannel, P.SendMessages, P.ManageMessages]);
    expect(channelAccess(s.channel, s.user, s.bot)).toBe("bot_missing_perms");
});

test("text and announcement channels with every permission are ok", () => {
    for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
        const s = setup(type, [P.ManageMessages], BOT_OK);
        expect(channelAccess(s.channel, s.user, s.bot)).toBe("ok");
    }
});

test("accessMessage names the channel", () => {
    expect(accessMessage.not_text("5")).toContain("<#5>");
    expect(accessMessage.user_cannot_manage("5")).toContain("<#5>");
    expect(accessMessage.bot_missing_perms("5")).toContain("<#5>");
});
