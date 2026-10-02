import { expect, test } from "bun:test";
import { ContainerBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type NetworkReviewComponentDeps, networkReviewComponent } from "./network-review.component";

function fakeInteraction(userId: string) {
    const log: string[] = [];
    const contents: string[] = [];
    const interaction = {
        user: { id: userId },
        isButton: () => true,
        reply: async (p: { content: string }) => {
            log.push("reply");
            contents.push(p.content);
        },
        deferUpdate: async () => {
            log.push("deferUpdate");
        },
        followUp: async (p: { content: string }) => {
            log.push("followUp");
            contents.push(p.content);
        },
        editReply: async () => {
            log.push("editReply");
        },
    };
    return { interaction, log, contents };
}

function fakeDeps(result: "ok" | "not_pending" | "banned" = "ok") {
    const rendered: boolean[] = [];
    const decisions: Array<{ guildId: string; ownerId: string; approve: boolean }> = [];
    const deps: NetworkReviewComponentDeps = {
        ownerIds: () => ["o1"],
        decide: async (_client, guildId, ownerId, approve) => {
            decisions.push({ guildId, ownerId, approve });
            return result;
        },
        renderDecided: async (_client, _guildId, approved) => {
            rendered.push(approved);
            return new ContainerBuilder();
        },
    };
    return { deps, decisions, rendered };
}

const client = {} as BotClient;

test("network-review: a non-owner click is refused and decides nothing", async () => {
    const { deps, decisions } = fakeDeps();
    const { interaction, log } = fakeInteraction("someone");
    await networkReviewComponent(deps).handle(interaction as never, ["g1", "approve"], client);
    expect(log).toEqual(["reply"]);
    expect(decisions).toHaveLength(0);
});

test("network-review: an owner's Approve decides and replaces the buttons", async () => {
    const { deps, decisions } = fakeDeps();
    const { interaction, log } = fakeInteraction("o1");
    await networkReviewComponent(deps).handle(interaction as never, ["g1", "approve"], client);
    expect(decisions).toEqual([{ guildId: "g1", ownerId: "o1", approve: true }]);
    expect(log).toEqual(["deferUpdate", "editReply"]);
});

test("network-review: a request no longer pending says so and leaves the message alone", async () => {
    const { deps } = fakeDeps("not_pending");
    const { interaction, log, contents } = fakeInteraction("o1");
    await networkReviewComponent(deps).handle(interaction as never, ["g1", "reject"], client);
    expect(log).toEqual(["deferUpdate", "followUp"]);
    expect(contents[0]).toContain("no longer pending");
});

test("network-review: malformed parts decide nothing", async () => {
    const { deps, decisions } = fakeDeps();
    const { interaction } = fakeInteraction("o1");
    await networkReviewComponent(deps).handle(interaction as never, ["g1", "maybe"], client);
    expect(decisions).toHaveLength(0);
});

test("network-review: approving a guild banned meanwhile shows it as rejected and says why", async () => {
    const { deps, rendered } = fakeDeps("banned");
    const { interaction, log, contents } = fakeInteraction("o1");
    await networkReviewComponent(deps).handle(interaction as never, ["g1", "approve"], client);
    expect(rendered).toEqual([false]);
    expect(log).toEqual(["deferUpdate", "editReply", "followUp"]);
    expect(contents[0]).toContain("banned");
});
