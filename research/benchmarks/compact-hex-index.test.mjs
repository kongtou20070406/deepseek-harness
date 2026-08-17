import test from "node:test";
import assert from "node:assert/strict";
import { CompactHexIndex, hexLabel } from "./compact-hex-index.mjs";

test("hex labels are opaque, stable and grouped", () => {
  const first = hexLabel("E", "Lufthansa");
  assert.equal(first, hexLabel("E", "lufthansa"));
  assert.match(first, /^E:[0-9a-f]{16}$/);
  assert.ok(!first.includes("lufthansa"));
});

test("cue codes retrieve grounded claims without injecting cue text", () => {
  const index = new CompactHexIndex();
  index.addRecord({ id: "u1", claims: [{
    claimId: "c1",
    sourceUnitId: "u1",
    claim: "用户喜欢 Crime Junkie。",
    quote: "I love Crime Junkie",
    retrievalCues: ["true crime documentary recommendation"],
    entities: ["Crime Junkie"],
  }] });
  const result = index.query("Can you recommend a true crime documentary?");
  assert.equal(result.rows[0]?.claimId, "c1");
  assert.ok([...index.postings.keys()].every((key) => !key.includes("documentary")));
});

test("contextual intent channels prefer the matching goal and role", () => {
  const index = new CompactHexIndex();
  index.addRecord({ id: "u1", claims: [{
    claimId: "day1", sourceUnitId: "u1", claim: "Apollo costs 90", quote: "Apollo is 90",
    thematicScopes: ["day 1 itinerary"], eventTypes: ["hotel comparison"], entityRoles: ["hotel price"],
  }] });
  index.addRecord({ id: "u2", claims: [{
    claimId: "day2", sourceUnitId: "u2", claim: "Apollo costs 120", quote: "Apollo is 120",
    thematicScopes: ["day 2 itinerary"], eventTypes: ["hotel comparison"], entityRoles: ["hotel price"],
  }] });
  const result = index.query("What was the Apollo hotel price for the day 2 itinerary?");
  assert.equal(result.rows[0]?.claimId, "day2");
});
