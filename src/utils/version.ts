/**
 * Which build is running - the commit the Docker build stamped into `version.txt`, so a deploy can
 * be confirmed from Discord (`!bot status`). Read once and cached.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
    /** `package.json` version. */
    version: string;
    /** Short commit hash - null when the build had no git history and no `GIT_SHA`. */
    commit: string | null;
    subject: string | null;
    committedAt: Date | null;
    /** When this process started. */
    startedAt: Date;
}

/** `version.txt` is three lines: short hash, ISO commit date, subject. Anything else = unknown. */
export function parseVersionFile(text: string): Pick<BuildInfo, "commit" | "subject" | "committedAt"> {
    const [commit, date, ...subject] = text.split(/\r?\n/);
    const committedAt = date ? new Date(date) : null;
    return {
        commit: commit?.trim() || null,
        subject: subject.join("\n").trim() || null,
        committedAt: committedAt && !Number.isNaN(committedAt.getTime()) ? committedAt : null,
    };
}

function readPackageVersion(root: string): string {
    try {
        return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/** Outside Docker (local dev), ask git directly. */
function readGit(root: string): string | null {
    try {
        const res = Bun.spawnSync(["git", "log", "-1", "--format=%h%n%cI%n%s"], { cwd: root, stdout: "pipe", stderr: "ignore" });
        return res.exitCode === 0 ? res.stdout.toString() : null;
    } catch {
        return null;
    }
}

let cached: BuildInfo | null = null;

export function getBuildInfo(root = process.cwd()): BuildInfo {
    if (cached) return cached;
    const file = join(root, "version.txt");
    const stamp = existsSync(file) ? readFileSync(file, "utf8") : (readGit(root) ?? process.env.GIT_SHA ?? "");
    cached = {
        version: readPackageVersion(root),
        ...parseVersionFile(stamp),
        startedAt: new Date(Date.now() - process.uptime() * 1000),
    };
    return cached;
}
