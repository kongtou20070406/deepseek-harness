import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class RingLog {
  constructor(path, { maxBytes = 1024 * 1024, keepLines = 300 } = {}) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.keepLines = keepLines;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(record) {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    if (statSync(this.path).size > this.maxBytes) this.compact();
  }

  compact() {
    const lines = readFileSync(this.path, "utf8").split(/\r?\n/).filter(Boolean).slice(-this.keepLines);
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${lines.join("\n")}\n`, "utf8");
    renameSync(temp, this.path);
  }

  tail(count = 20) {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-count)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  }
}
