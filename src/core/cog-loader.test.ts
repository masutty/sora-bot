import { expect, test } from "bun:test";
import { eventTraceSubject } from "./cog-loader";

test("eventTraceSubject reads userId/userTag/guildId off a Message-like first arg (.author)", () => {
    const message = { author: { id: "u1", username: "masutty" }, guildId: "g1" };
    expect(eventTraceSubject([message])).toEqual({ userId: "u1", userTag: "masutty", guildId: "g1" });
});

test("eventTraceSubject reads userId/userTag/guildId off an Interaction-like first arg (.user)", () => {
    const interaction = { user: { id: "u2", username: "someone" }, guildId: "g2" };
    expect(eventTraceSubject([interaction])).toEqual({ userId: "u2", userTag: "someone", guildId: "g2" });
});

test("eventTraceSubject omits guildId when the first arg has none (a DM, or the field is null)", () => {
    const message = { author: { id: "u1", username: "masutty" }, guildId: null };
    expect(eventTraceSubject([message])).toEqual({ userId: "u1", userTag: "masutty" });
});

test("eventTraceSubject returns {} for an event whose first arg exposes neither .user nor .author", () => {
    expect(eventTraceSubject([{ some: "shard-event-payload" }])).toEqual({});
});

test("eventTraceSubject returns {} for no args, or a non-object first arg", () => {
    expect(eventTraceSubject([])).toEqual({});
    expect(eventTraceSubject([42])).toEqual({});
    expect(eventTraceSubject([null])).toEqual({});
});
