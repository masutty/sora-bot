import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as realQuotaRoles from "../repository/quota-roles.repository";

const upserts: unknown[][] = [];

mock.module("../repository/quota-roles.repository", () => ({
    ...realQuotaRoles,
    upsertQuotaRole: async (...args: unknown[]) => {
        upserts.push(args);
        return {};
    },
}));

import { createQuota } from "./quota.service";

afterAll(() => mock.module("../repository/quota-roles.repository", () => realQuotaRoles));
beforeEach(() => {
    upserts.length = 0;
});

test("createQuota: fixed mode always stores a 24h window", async () => {
    await createQuota("g", "r", "F", 5, 72, 1);
    expect(upserts).toEqual([["g", "r", "F", 5 * 3600, 24, 1]]);
});

test("createQuota: rolling window mode keeps the given window", async () => {
    await createQuota("g", "r", "RW", 5, 72, null);
    expect(upserts).toEqual([["g", "r", "RW", 5 * 3600, 72, null]]);
});

test("createQuota: fixed mode ignores a zero window", async () => {
    await createQuota("g", "r", "F", 5, 0, 1);
    expect(upserts).toEqual([["g", "r", "F", 5 * 3600, 24, 1]]);
});
