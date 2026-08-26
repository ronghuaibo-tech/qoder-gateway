import fs from "node:fs";
import path from "node:path";
import { applyQoderPatch } from "../src/core/qoder-patch.mjs";

const APP_ROOT = "/Applications/Qoder CN IDE.app/Contents/Resources/app";
const extensionPath = path.join(APP_ROOT, "extensions/aicoding-agent/dist/extension.js");

if (!fs.existsSync(extensionPath)) {
  console.error(`Qoder extension not found: ${extensionPath}`);
  process.exit(1);
}

const before = fs.readFileSync(extensionPath, "utf8");
console.log(`before V27=${before.includes("QODER_BRIDGE_GATEWAY_PATCH_20260826_V27")}`);
console.log(`before stopped=${before.includes("Stopped a repeated local tool call")}`);
console.log(`before limitStop=${before.includes("Stopped the local tool loop after")}`);

const result = await applyQoderPatch({
  appRoot: APP_ROOT,
  models: [
    { id: "Qwen3.8max", capabilities: { reasoning: true } },
    { id: "GLM5.2", capabilities: { reasoning: true } },
    { id: "GLM5.3", capabilities: { reasoning: true } }
  ]
});
for (const file of result.files) {
  console.log(`${file.changed ? "patched" : "unchanged"} ${file.file}`);
}

const after = fs.readFileSync(extensionPath, "utf8");
console.log(`after V27=${after.includes("QODER_BRIDGE_GATEWAY_PATCH_20260826_V27")}`);
console.log(`after stopped=${after.includes("Stopped a repeated local tool call")}`);
console.log(`after reuse=${after.includes("repeated tool call reused previous result")}`);
console.log(`after limit=${after.includes("tool loop limit reached after")}`);
if (
  after.includes("Stopped a repeated local tool call")
  || after.includes("Stopped the local tool loop after")
  || !after.includes("QODER_BRIDGE_GATEWAY_PATCH_20260826_V27")
  || !after.includes("tool loop limit reached after")
) {
  console.error("V27 was not applied to the Qoder extension bundle.");
  process.exit(1);
}
console.log("V27 is on disk. Fully quit Qoder with Command+Q and reopen it.");
