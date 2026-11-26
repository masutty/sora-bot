import { expect, test } from "bun:test";
import { splitDuration, splitWeight } from "./parse-args";

test("splitWeight reads a leading Nx", () => {
    expect(splitWeight("3x spam")).toEqual({ weight: 3, reason: "spam" });
    expect(splitWeight("2X")).toEqual({ weight: 2, reason: "" });
});

test("splitWeight leaves anything that is not exactly Nx as the reason", () => {
    expect(splitWeight("x3 spam")).toEqual({ weight: 1, reason: "x3 spam" });
    expect(splitWeight("0x spam")).toEqual({ weight: 1, reason: "0x spam" });
    expect(splitWeight("3xyz spam")).toEqual({ weight: 1, reason: "3xyz spam" });
    expect(splitWeight("spam 3x")).toEqual({ weight: 1, reason: "spam 3x" });
    expect(splitWeight("")).toEqual({ weight: 1, reason: "" });
});

test("splitDuration: a durationless ban keeps the whole text as the reason", () => {
    expect(splitDuration("stop doing that")).toEqual({ seconds: null, reason: "stop doing that" });
});

test("splitDuration: a bare number is not a duration", () => {
    expect(splitDuration("5 spam")).toEqual({ seconds: null, reason: "5 spam" });
});

test("splitDuration reads units, compound forms and the reason after them", () => {
    expect(splitDuration("30m spam")).toEqual({ seconds: 1800, reason: "spam" });
    expect(splitDuration("1h30m")).toEqual({ seconds: 5400, reason: "" });
    expect(splitDuration("7d being rude")).toEqual({ seconds: 604800, reason: "being rude" });
});

test("splitDuration: a word with letters that is not a duration stays the reason", () => {
    expect(splitDuration("spam forever")).toEqual({ seconds: null, reason: "spam forever" });
    expect(splitDuration("5x spam")).toEqual({ seconds: null, reason: "5x spam" });
});

test("the reason: prefix forces everything after it to be the reason", () => {
    expect(splitDuration("reason: 7d is the limit")).toEqual({ seconds: null, reason: "7d is the limit" });
    expect(splitWeight("reason: 3x spam")).toEqual({ weight: 1, reason: "3x spam" });
    expect(splitDuration("7d reason: 5 spam")).toEqual({ seconds: 604800, reason: "5 spam" });
    expect(splitWeight("2x reason: spam")).toEqual({ weight: 2, reason: "spam" });
});
