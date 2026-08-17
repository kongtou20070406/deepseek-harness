import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LunaBudgetLedger } from "./budget-ledger.mjs";
import { completeLuna } from "./luna-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ledger = await new LunaBudgetLedger(join(here, "luna-budget.json")).load();
const prompt = "只输出 JSON：{\"answer\":\"LUNA_OK\"}";
const reservation = ledger.reserve({ prompt, maxTokens: 80, runId: "runtime-probe", caseId: "probe-1", condition: "direct" });
try {
  const result = await completeLuna(prompt, { maxTokens: 80 });
  const charged = await ledger.settle(reservation, result.usage);
  process.stdout.write(`${JSON.stringify({ ...result, charged, aggregate: ledger.ledger.usage }, null, 2)}\n`);
} catch (error) {
  await ledger.settle(reservation, null, { failed: true, error: error.message });
  throw error;
}
