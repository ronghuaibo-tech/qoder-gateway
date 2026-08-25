import { applyQoderPatch } from "../src/core/qoder-patch.mjs";

try {
  const result = await applyQoderPatch();
  for (const file of result.files) {
    console.log(`${file.changed ? "patched" : "already patched"} ${file.file}`);
  }
  console.log(`gateway=${result.gateway}`);
  console.log(`models=${result.models.join(",")}`);
  console.log(`updates=${result.updates}`);
  console.log(`system_push=${result.system_push}`);
  console.log(`backup=${result.backup}`);
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
