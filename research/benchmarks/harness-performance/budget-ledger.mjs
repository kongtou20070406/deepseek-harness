import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const LUNA_HARD_LIMIT = 100_000_000;

function blankLedger() {
  return {
    schema: 1,
    model: "openai-codex/gpt-5.6-luna",
    hardLimit: LUNA_HARD_LIMIT,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    calls: 0,
    failedCalls: 0,
    conservativeCharges: 0,
    runs: {},
    recent: [],
    updatedAt: null,
  };
}

function normalizedUsage(usage = {}) {
  usage ||= {};
  const result = {
    input: Number(usage.input) || 0,
    output: Number(usage.output) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    cacheWrite: Number(usage.cacheWrite) || 0,
  };
  result.total = result.input + result.output + result.cacheRead + result.cacheWrite;
  return result;
}

export function worstCaseReservation(prompt, maxTokens) {
  // OpenAI tokenization is byte based, so UTF-8 byte length is a conservative
  // prompt ceiling. The additional allowance covers provider/system framing.
  return Buffer.byteLength(String(prompt), "utf8") + Number(maxTokens || 0) + 65_536;
}

export class LunaBudgetLedger {
  constructor(path) {
    this.path = path;
    this.ledger = null;
    this.reserved = 0;
    this.sequence = 0;
    this.persistChain = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.ledger = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.ledger = blankLedger();
      await this.persist();
    }
    if (this.ledger.hardLimit !== LUNA_HARD_LIMIT) {
      throw new Error(`Luna ledger hard limit mismatch: ${this.ledger.hardLimit}`);
    }
    return this;
  }

  reserve({ prompt, maxTokens, runId, caseId, condition }) {
    if (!this.ledger) throw new Error("Budget ledger is not loaded.");
    const amount = worstCaseReservation(prompt, maxTokens);
    const projected = this.ledger.usage.total + this.reserved + amount;
    if (projected > this.ledger.hardLimit) {
      throw new Error(`Luna aggregate budget refused request: ${projected} > ${this.ledger.hardLimit}`);
    }
    this.reserved += amount;
    return { id: ++this.sequence, amount, runId, caseId, condition };
  }

  async settle(reservation, usage, { failed = false, error = null } = {}) {
    const observed = normalizedUsage(usage);
    // A failed provider request may have consumed tokens without returning usage.
    // Charge the full reservation so failure can never silently relax the cap.
    const charged = failed && observed.total === 0
      ? { input: reservation.amount, output: 0, cacheRead: 0, cacheWrite: 0, total: reservation.amount }
      : observed;
    if (charged.total > reservation.amount) {
      throw new Error(`Provider usage ${charged.total} exceeded conservative reservation ${reservation.amount}`);
    }
    this.reserved -= reservation.amount;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      this.ledger.usage[key] += charged[key];
    }
    this.ledger.calls += 1;
    if (failed) this.ledger.failedCalls += 1;
    if (failed && observed.total === 0) this.ledger.conservativeCharges += charged.total;
    const run = this.ledger.runs[reservation.runId] || {
      calls: 0,
      failedCalls: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    run.calls += 1;
    if (failed) run.failedCalls += 1;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) run.usage[key] += charged[key];
    this.ledger.runs[reservation.runId] = run;
    this.ledger.recent.push({
      at: new Date().toISOString(),
      runId: reservation.runId,
      caseId: reservation.caseId,
      condition: reservation.condition,
      charged: charged.total,
      failed,
      error: error ? String(error).slice(0, 300) : null,
    });
    this.ledger.recent = this.ledger.recent.slice(-25);
    this.ledger.updatedAt = new Date().toISOString();
    if (this.ledger.usage.total > this.ledger.hardLimit) {
      throw new Error(`Luna aggregate budget exceeded: ${this.ledger.usage.total}`);
    }
    await this.persist();
    return charged;
  }

  async persist() {
    const snapshot = `${JSON.stringify(this.ledger, null, 2)}\n`;
    const temp = `${this.path}.tmp`;
    this.persistChain = this.persistChain.then(async () => {
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.path);
    });
    return this.persistChain;
  }
}
