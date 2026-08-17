import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RingLog } from "../src/ring-log.js";

test("ring log remains bounded and keeps newest records", () => {
  const path = join(mkdtempSync(join(tmpdir(), "idea-ring-")), "log.jsonl");
  const log = new RingLog(path, { maxBytes: 220, keepLines: 4 });
  for (let index = 0; index < 20; index += 1) log.append({ index, text: "x".repeat(30) });
  const tail = log.tail(4);
  assert.equal(tail.at(-1).index, 19);
  assert.ok(readFileSync(path, "utf8").length < 500);
});
