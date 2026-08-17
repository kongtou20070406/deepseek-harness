import { mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "./adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..", "third_party", "memsyco");
const output = resolve(process.argv[2] || defaultRoot);
const base = "https://raw.githubusercontent.com/XMUDeepLIT/MemSyco-Bench/main/data/";

async function download(name) {
  const response = await fetch(new URL(name, base));
  if (!response.ok) throw new Error(`Download failed ${response.status} ${name}`);
  return Buffer.from(await response.arrayBuffer());
}

async function writeAbsentOrIdentical(path, bytes) {
  try {
    await access(path, constants.F_OK);
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`Refusing to overwrite non-identical file ${path}`);
    return "reused";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, bytes, { flag: "wx" });
  return "downloaded";
}

await mkdir(output, { recursive: true });
const manifestBytes = await download("manifest.json");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest?.name !== "MemSyco-Bench" || manifest?.schema_version !== "1.2" || manifest?.total_samples !== 1550) {
  throw new Error("Refusing an unexpected MemSyco release manifest");
}
const names = ["manifest.json", manifest.schema_file, ...Object.values(manifest.tasks).map((task) => task.file)];
for (const name of names) {
  const bytes = name === "manifest.json" ? manifestBytes : await download(name);
  const status = await writeAbsentOrIdentical(join(output, name), bytes);
  process.stdout.write(`${status} ${name} ${bytes.length}\n`);
}
const loaded = await loadMemSycoBench(output);
process.stdout.write(`${JSON.stringify({
  root: output,
  cases: loaded.cases.length,
  sha256: loaded.sha256,
  schemaVersion: loaded.schemaVersion,
  counts: loaded.counts,
}, null, 2)}\n`);
