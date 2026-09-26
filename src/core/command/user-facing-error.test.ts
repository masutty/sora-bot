import { expect, test } from "bun:test";
import { describeCommandError, UserFacingError } from "./user-facing-error";

class DomainError extends UserFacingError {}

test("a UserFacingError (or subclass) shows its message verbatim", () => {
    expect(describeCommandError(new DomainError("Unknown biome: X"))).toEqual({ kind: "user", message: "Unknown biome: X" });
});

test("anything else is internal - its message must never reach the user", () => {
    expect(describeCommandError(new Error("ECONNREFUSED 10.0.0.3:5432"))).toEqual({ kind: "internal" });
    expect(describeCommandError("a thrown string")).toEqual({ kind: "internal" });
});
