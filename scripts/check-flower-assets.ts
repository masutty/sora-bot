/**
 * Every FLOWER_META entry must resolve to an existing avatar file. `flowerAssetPath` is built from
 * `__dirname`, so moving flowers.constants.ts to another folder silently breaks it at runtime
 * (tsc can't see it) - this catches that before boot, no DB/Discord connection needed.
 */
import { existsSync } from "node:fs";
import { FLOWER_META, flowerAssetPath } from "@/usermodules/biomehunt/constants/flowers.constants";

const missing = Object.keys(FLOWER_META).filter((flower) => !existsSync(flowerAssetPath(flower)));
if (missing.length) {
    console.error(`❌ Missing flower assets: ${missing.join(", ")}`);
    process.exit(1);
}
console.log(`✅ ${Object.keys(FLOWER_META).length} flower assets found.`);
