import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

/** UTF-8 bytes conservatively upper-bound prompt tokens. The catalog output
 * capability is reserved because Pi 0.84.1 has no per-call max-token flag. */
export function conservativeModelReservation(prompt, catalogMaxOutput = 128_000) {
  return Buffer.byteLength(String(prompt), "utf8") + Number(catalogMaxOutput || 0) + 65_536;
}

export class ModelRunBudgetLedger {
  constructor({ path, model, hardTokenLimit, hardCallLimit, reservationEstimator = conservativeModelReservation }) {
    if (!path) throw new Error("budget ledger path is required");
    if (!model) throw new Error("budget model is required");
    if (!Number.isSafeInteger(hardTokenLimit) || hardTokenLimit < 1) throw new Error("hardTokenLimit must be positive");
    if (!Number.isSafeInteger(hardCallLimit) || hardCallLimit < 1) throw new Error("hardCallLimit must be positive");
    this.path = path;
    this.model = model;
    this.hardTokenLimit = hardTokenLimit;
    this.hardCallLimit = hardCallLimit;
    this.reservationEstimator = reservationEstimator;
    this.ledger = null;
    this.reserved = 0;
    this.open = new Map();
    this.sequence = 0;
    this.persistChain = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.ledger = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.ledger = {
        schema: 1,
        model: this.model,
        hardTokenLimit: this.hardTokenLimit,
        hardCallLimit: this.hardCallLimit,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        calls: 0,
        failedCalls: 0,
        conservativeCharges: 0,
        recent: [],
        updatedAt: null,
      };
      await this.persist();
    }
    for (const [field, expected] of [
      ["model", this.model],
      ["hardTokenLimit", this.hardTokenLimit],
      ["hardCallLimit", this.hardCallLimit],
    ]) {
      if (this.ledger[field] !== expected) throw new Error(`Budget ledger ${field} mismatch: ${this.ledger[field]} != ${expected}`);
    }
    return this;
  }

  reserve({ prompt, catalogMaxOutput, runId, caseId, lane }) {
    if (!this.ledger) throw new Error("budget ledger is not loaded");
    const amount = Number(this.reservationEstimator(prompt, catalogMaxOutput));
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid reservation amount");
    if (this.ledger.calls + this.open.size + 1 > this.hardCallLimit) {
      throw new Error(`Sol run call budget refused request: ${this.ledger.calls + this.open.size + 1} > ${this.hardCallLimit}`);
    }
    if (this.ledger.usage.total + this.reserved + amount > this.hardTokenLimit) {
      throw new Error(`Sol run token budget refused request: ${this.ledger.usage.total + this.reserved + amount} > ${this.hardTokenLimit}`);
    }
    const reservation = { id: ++this.sequence, amount, runId, caseId, lane };
    this.reserved += amount;
    this.open.set(reservation, amount);
    return reservation;
  }

  async settle(reservation, usage, { failed = false, error = null } = {}) {
    if (!this.open.has(reservation)) throw new Error("unknown or already settled reservation");
    const observed = normalizedUsage(usage);
    const charged = failed && observed.total === 0
      ? { input: reservation.amount, output: 0, cacheRead: 0, cacheWrite: 0, total: reservation.amount }
      : observed;
    if (charged.total > reservation.amount) {
      throw new Error(`Provider usage ${charged.total} exceeded conservative reservation ${reservation.amount}`);
    }
    this.open.delete(reservation);
    this.reserved -= reservation.amount;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) this.ledger.usage[key] += charged[key];
    this.ledger.calls += 1;
    if (failed) this.ledger.failedCalls += 1;
    if (failed && observed.total === 0) this.ledger.conservativeCharges += charged.total;
    this.ledger.recent.push({
      at: new Date().toISOString(), runId: reservation.runId, caseId: reservation.caseId,
      lane: reservation.lane, charged: charged.total, failed, error: error ? String(error).slice(0, 300) : null,
    });
    this.ledger.recent = this.ledger.recent.slice(-25);
    this.ledger.updatedAt = new Date().toISOString();
    if (this.ledger.usage.total > this.hardTokenLimit || this.ledger.calls > this.hardCallLimit) {
      throw new Error("model run budget invariant exceeded");
    }
    await this.persist();
    return charged;
  }

  snapshot() {
    if (!this.ledger) return null;
    return {
      model: this.model,
      hardTokenLimit: this.hardTokenLimit,
      hardCallLimit: this.hardCallLimit,
      usage: structuredClone(this.ledger.usage),
      calls: this.ledger.calls,
      failedCalls: this.ledger.failedCalls,
      conservativeCharges: this.ledger.conservativeCharges,
      reserved: this.reserved,
    };
  }

  async persist() {
    const snapshot = `${JSON.stringify(this.ledger, null, 2)}\n`;
    const temporary = `${this.path}.tmp`;
    this.persistChain = this.persistChain.then(async () => {
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, this.path);
    });
    return this.persistChain;
  }
}
