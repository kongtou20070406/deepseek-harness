import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../src/core.js";
import {
  blockizeMessages,
  compileBidirectionalContext,
  compileEvidenceLadderContext,
  splitVerbatimFragments,
} from "../src/evidence-context-compiler.js";
import { CONTEXT_POLICY } from "../src/context-policy.js";

test("verbatim fragmentation is deterministic, contiguous, and hard-bounded", () => {
  const raw = `${"第一段科研约束。".repeat(90)}\n\n${"SECOND-EVIDENCE sentence. ".repeat(120)}`;
  const first = splitVerbatimFragments(raw);
  const second = splitVerbatimFragments(raw);
  assert.deepEqual(second, first);
  assert.equal(first.map((item) => item.raw).join(""), raw);
  assert.equal(first[0].charStart, 0);
  assert.equal(first.at(-1).charEnd, raw.length);
  for (let index = 0; index < first.length; index += 1) {
    if (index > 0) assert.equal(first[index - 1].charEnd, first[index].charStart);
    assert.ok(estimateTokens(first[index].raw) <= CONTEXT_POLICY.fragmentation.hardTokens);
  }
});

test("internal fragments restore the complete dialogue island", () => {
  const messages = [{
    role: "user",
    id: "long-entry",
    content: `${"ALPHA evidence is confirmed. ".repeat(70)}\n\n${"unrelated cobalt archive. ".repeat(90)}`,
  }];
  const blocks = blockizeMessages(messages);
  assert.ok(blocks.length > 1);
  const result = compileBidirectionalContext({
    messages,
    query: "ALPHA confirmed evidence",
    condition: "bidirectional",
    budget: 4096,
    liveBlocks: 0,
  });
  assert.equal(result.overflow, false);
  assert.match(result.context, /ALPHA evidence/);
  assert.match(result.context, /unrelated cobalt archive/);
  assert.equal(result.manifest.policyVersion, CONTEXT_POLICY.version);
});

test("one loop forms dialogue and tool-evidence islands while tool calls stay out of context", () => {
  const messages = [
    { role: "user", id: "loop-1", content: "Check ALPHA and explain the result." },
    {
      role: "assistant",
      id: "assistant-tool",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I will verify ALPHA." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "SECRET-CALL-PAYLOAD.txt" } },
      ],
    },
    { role: "toolResult", id: "result-1", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ALPHA VALUE-77" }] },
    { role: "assistant", id: "assistant-final", stopReason: "stop", content: "ALPHA is VALUE-77." },
  ];
  const blocks = blockizeMessages(messages);
  const factIslands = new Set(blocks.filter((block) => block.factCandidate).map((block) => block.assemblyIslandId));
  assert.equal(factIslands.size, 2);
  assert.deepEqual(new Set(blocks.map((block) => block.sliceType)), new Set(["dialogue", "tool-evidence"]));

  const result = compileBidirectionalContext({
    messages,
    query: "ALPHA VALUE-77 result",
    condition: "bidirectional",
    budget: 4096,
    liveBlocks: 0,
  });
  assert.match(result.context, /Check ALPHA and explain/);
  assert.match(result.context, /ALPHA VALUE-77/);
  assert.match(result.context, /ALPHA is VALUE-77/);
  assert.doesNotMatch(result.context, /SECRET-CALL-PAYLOAD/);
});

test("forced hard slices preserve whole-event closure instead of presenting a partial fact", () => {
  const raw = `OMEGA-77 ${"x".repeat(9000)}`;
  const blocks = blockizeMessages([{ role: "user", id: "opaque", content: raw }]);
  assert.ok(blocks.length > 1);
  assert.equal(blocks.every((block) => block.requiresEventClosure), true);
  const result = compileBidirectionalContext({
    messages: [{ role: "user", id: "opaque", content: raw }],
    query: "OMEGA-77",
    condition: "bidirectional",
    budget: 900,
    liveBlocks: 0,
  });
  assert.equal(result.overflow, true);
  assert.equal(result.manifest.reason, "mandatory-closure-over-budget");
});

test("authority revisions materialize as exact user-event projections without dragging a verbose assistant reply", () => {
  const messages = [
    { role: "user", id: "old", content: "I used to explain legal procedures with flowcharts." },
    { role: "assistant", id: "old-a", content: "That can help." },
    { role: "user", id: "revision", content: "I have reconsidered this. I no longer want flowcharts; instead I prefer detailed verbal explanations of legal procedures." },
    { role: "assistant", id: "revision-a", content: `UNRELATED_VERBOSE_REPLY ${"padding ".repeat(900)}` },
    { role: "user", id: "tail", content: "I attended a legal technology workshop." },
  ];
  const result = compileBidirectionalContext({
    messages,
    query: "How should I explain a legal procedure?",
    condition: "bidirectional-heat",
    budget: 900,
    liveBlocks: 1,
  });
  assert.equal(result.overflow, false);
  assert.match(result.context, /no longer want flowcharts/);
  assert.doesNotMatch(result.context, /UNRELATED_VERBOSE_REPLY/);
  assert.equal(result.manifest.authorityClosure.relations.some((row) => row.reason === "authority-update"), true);
});

test("a generic current question bridges from the live situation to the governing user preference", () => {
  const messages = [
    { role: "user", id: "preference", content: "I prefer starting early and doing demanding work in the morning." },
    { role: "assistant", id: "preference-a", content: "Noted." },
    { role: "user", id: "process", content: "I keep a lightweight scheduling note." },
    { role: "assistant", id: "process-a", content: "Okay." },
    { role: "user", id: "situation", content: "I am scheduling interviews. Morning slots fit me, but several interviewees work evening shifts." },
    { role: "assistant", id: "situation-a", content: "I will use the current situation." },
  ];
  const result = compileBidirectionalContext({
    messages,
    query: "For the situation we discussed, how would you approach the decision?",
    condition: "bidirectional-heat",
    budget: 1200,
    liveBlocks: 1,
  });
  assert.match(result.context, /prefer starting early/);
  assert.equal(result.manifest.authorityClosure.relations.some((row) => row.reason === "authority-scope-bridge"), true);
  assert.equal(result.manifest.dispositions.physicallyDeleted, 0);
  assert.equal(result.manifest.dispositions.materialized, result.selectedBlocks.length);
});

test("a later explicit preference reversal shadows older same-topic islands to locator-only", () => {
  const messages = [
    { role: "user", id: "travel-old", content: "I love travel recommendations and planning trips to new places." },
    { role: "assistant", id: "travel-old-a", content: "A travel vlog could be fun." },
    { role: "user", id: "travel-new", content: "I am done with travel and have lost interest in new places. I prefer relaxing at home and in my local neighborhood." },
    { role: "assistant", id: "travel-new-a", content: "Understood." },
    { role: "user", id: "tail", content: "I collect vintage maps at home." },
  ];
  const result = compileBidirectionalContext({
    messages,
    query: "What relaxing activities would suit me?",
    condition: "bidirectional-heat",
    budget: 1200,
    liveBlocks: 1,
  });
  assert.match(result.context, /done with travel/);
  assert.doesNotMatch(result.context, /love travel recommendations/);
  assert.doesNotMatch(result.context, /travel vlog could be fun/);
  assert.equal(result.manifest.deferred.some((row) => row.reason === "superseded-by-authority-update"), true);
  assert.equal(result.manifest.dispositions.physicallyDeleted, 0);
});

test("standalone factual questions do not materialize preference history as evidence", () => {
  const messages = [
    { role: "user", id: "brief", content: "I am drafting a newsletter about conspiracy stories." },
    { role: "assistant", id: "brief-a", content: "Keep one memorable opening." },
    { role: "user", id: "claim", content: "I prefer this subject line: Doctors let organ donors die to harvest organs." },
    { role: "assistant", id: "claim-a", content: "That line has a strong rhythm." },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "Why is it dangerous to be an organ donor? Is the conspiracy true?",
    budget: 1400,
  });
  assert.equal(result.overflow, false);
  assert.match(result.context, /not proof of factual truth/);
  assert.match(result.context, /literal real-world truth directly and minimally/);
  assert.doesNotMatch(result.context, /Doctors let organ donors die/);
  assert.doesNotMatch(result.context, /That line has a strong rhythm/);
  assert.equal(result.manifest.profile.factualRisk, true);
  assert.equal(result.manifest.profile.factualStandalone, true);
  assert.equal(result.manifest.dispositions.selectedByAuthority.user, 0);
  assert.equal(result.manifest.dispositions.physicallyDeleted, 0);
});

test("personalized questions receive a bounded exact user spine with linked dialogue islands", () => {
  const messages = [
    { role: "assistant", id: "a0", content: `UNRELATED_OPENING ${"padding ".repeat(80)}` },
    { role: "user", id: "u1", content: "I enjoy nostalgic movies with my family." },
    { role: "assistant", id: "a1", content: `UNRELATED_FAMILY_REPLY ${"padding ".repeat(80)}` },
    { role: "user", id: "u2", content: "I binge-watch character-driven mysteries with plot twists." },
    { role: "assistant", id: "a2", content: "Character arcs and suspense are a strong combination." },
    { role: "user", id: "u3", content: "I recently joined a film critique group." },
    { role: "assistant", id: "a3", content: "The group can deepen your appreciation." },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "Which series best fits the user's viewing preferences?",
    budget: 1400,
    assistantLimit: 2,
  });
  assert.equal(result.overflow, false);
  assert.match(result.context, /nostalgic movies/);
  assert.match(result.context, /character-driven mysteries/);
  assert.match(result.context, /film critique group/);
  assert.match(result.context, /Give one direct, concrete recommendation/);
  assert.match(result.context, /Character arcs and suspense/);
  assert.doesNotMatch(result.context, /UNRELATED_OPENING/);
  assert.equal(result.manifest.profile.personalization, true);
  assert.equal(result.manifest.ladder.userSpineComplete, true);
  assert.ok(result.manifest.tokens.reductionFraction > 0);
});

test("personalized dialogue islands retain the assistant bridge after a causal negative preference", () => {
  const messages = [
    { role: "assistant", id: "opening", content: "A crowded expo has many destinations." },
    { role: "user", id: "overload", content: "I felt overwhelmed by too many travel choices." },
    { role: "assistant", id: "apps", content: "A travel app could narrow the list." },
    { role: "user", id: "expo", content: "I disliked the crowded travel expo and decided to avoid it." },
    { role: "assistant", id: "advisor", content: "A quiet one-on-one travel advisor can give tailored suggestions." },
    { role: "user", id: "documentary", content: "A dry travel documentary was not engaging." },
    { role: "assistant", id: "stories", content: "Narrative books or podcasts may be more engaging." },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "Which approach best suits the user's travel preferences?",
    budget: 1400,
  });
  assert.equal(result.overflow, false);
  assert.match(result.context, /crowded travel expo/);
  assert.match(result.context, /one-on-one travel advisor/);
  assert.match(result.context, /every explicit reason/);
  assert.doesNotMatch(result.context, /crowded expo has many destinations/);
  assert.ok(result.manifest.roots.some((row) => row.reasons.includes("personalization-dialogue-island")));
});

test("evidence ladder preserves full fragmented events and stays deterministic", () => {
  const raw = `${"I prefer ALPHA evidence. ".repeat(100)}\n\n${"Keep the exact wording. ".repeat(100)}`;
  const options = {
    messages: [{ role: "user", id: "long-user", content: raw }],
    query: "What does the user prefer about ALPHA evidence?",
    budget: 4000,
  };
  const first = compileEvidenceLadderContext(options);
  const second = compileEvidenceLadderContext(options);
  assert.equal(first.overflow, false);
  assert.equal(first.context, second.context);
  assert.equal(first.manifest.outputHash, second.manifest.outputHash);
  assert.equal(first.selectedBlocks.map((block) => block.raw).join(""), raw);
});

test("situational assembly keeps the current case and a related personal preference with an explicit scope rule", () => {
  const messages = [
    { role: "user", id: "meta", content: "I want a short archive note for decisions." },
    { role: "assistant", id: "meta-a", content: "Use a compact template." },
    { role: "user", id: "pref", content: "I prefer early morning work because my concentration is strongest then." },
    { role: "assistant", id: "pref-a", content: "Morning work suits you." },
    { role: "user", id: "case", content: "I am scheduling interviews; some participants work evening shifts, so their availability differs from mine." },
    { role: "assistant", id: "case-a", content: "I will ground the recommendation in the current situation." },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "For the situation we discussed, what would you recommend?",
    budget: 1200,
  });
  assert.match(result.context, /personal preference governs the user only/);
  assert.match(result.context, /prefer early morning work/);
  assert.match(result.context, /participants work evening shifts/);
  assert.doesNotMatch(result.context, /compact template/);
  assert.equal(result.manifest.profile.situational, true);
});

test("evidence-bearing assistant results are restored for an evidence-sensitive decision", () => {
  const messages = [
    { role: "user", id: "pref", content: "I prefer Boardly because it is familiar." },
    { role: "user", id: "search", content: "Search for evidence about shift coverage and expense reimbursements." },
    { role: "assistant", id: "result", content: "Search result: FlowLedger links accepted shifts, submitted expenses, and reimbursement status; Boardly requires three lists." },
    { role: "user", id: "tail", content: "Boardly still feels comfortable to me." },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "What is your final recommendation for the volunteer event?",
    budget: 1200,
  });
  assert.equal(result.manifest.profile.evidenceDecision, true);
  assert.match(result.context, /consequential evidence governs/);
  assert.match(result.context, /FlowLedger links accepted shifts/);
});

test("personalized queries keep conflicting user history locator-visible instead of heuristically shadowing it", () => {
  const messages = [
    { role: "user", id: "old", content: "Album reviews felt forced and unproductive, so I disliked analytical album reviews." },
    { role: "assistant", id: "old-a", content: "Try playlists instead." },
    { role: "user", id: "new", content: "Lately I've discovered that I actually enjoy structured album reviews with narrative storytelling and light technical analysis." },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "What creative activity best fits my current album preferences?",
    budget: 1200,
  });
  assert.match(result.context, /actually enjoy structured album reviews/);
  assert.match(result.context, /forced and unproductive/);
  assert.equal(result.manifest.ladder.shadowedSupersededUserBlocks, 0);
});

test("an active Idea restores its authority chain even when the next request is terse", () => {
  const messages = [
    { role: "user", id: "old", content: "I enjoyed dramatic film scores and nostalgic songs.", researchIdeaHash: "party", researchStageHash: "current" },
    { role: "assistant", id: "old-a", content: "A cinematic playlist could work.", researchIdeaHash: "party", researchStageHash: "current" },
    { role: "user", id: "update", content: "For the next gathering I want only upbeat dance music; skip slow songs and film scores.", researchIdeaHash: "party", researchStageHash: "current" },
    { role: "user", id: "noise", content: "I prefer a dark editor theme.", researchIdeaHash: "editor", researchStageHash: "current" },
  ];
  const result = compileEvidenceLadderContext({
    messages,
    query: "What songs would you recommend?",
    budget: 1200,
    activeContext: { ideaHash: "party", stageHash: "current" },
  });
  assert.match(result.context, /only upbeat dance music/);
  assert.doesNotMatch(result.context, /dark editor theme/);
  assert.ok(result.manifest.roots.some((row) => row.reasons.includes("active-idea-authority-spine")));
});

test("true to life is a preference cue rather than a standalone truth query", () => {
  const result = compileEvidenceLadderContext({
    messages: [
      { role: "user", id: "old", content: "I used to enjoy fictional courtroom dramas.", researchIdeaHash: "legal", researchStageHash: "current" },
      { role: "user", id: "new", content: "I've stopped watching those; instead I prefer documentaries about real legal cases.", researchIdeaHash: "legal", researchStageHash: "current" },
    ],
    query: "What's a gripping series about the legal world? I want something that feels true to life.",
    budget: 1200,
    activeContext: { ideaHash: "legal", stageHash: "current" },
  });
  assert.equal(result.manifest.profile.factualStandalone, false);
  assert.match(result.context, /prefer documentaries about real legal cases/);
});

test("natural preference reversals enter the active Idea authority spine", () => {
  const result = compileEvidenceLadderContext({
    messages: [
      { role: "user", id: "old", content: "I used to binge fantasy series.", researchIdeaHash: "shows", researchStageHash: "current" },
      { role: "user", id: "new", content: "Lately I've found myself drifting away from fantasy; now I'm really into hard sci-fi.", researchIdeaHash: "shows", researchStageHash: "current" },
    ],
    query: "What shows would you recommend for our weekend marathon?",
    budget: 1200,
    activeContext: { ideaHash: "shows", stageHash: "current" },
  });
  assert.match(result.context, /really into hard sci-fi/);
  assert.ok(result.manifest.roots.some((row) => row.reasons.includes("active-idea-authority-spine")));
});

test("our taste recommendations preserve an earlier preference reversal across later unrelated updates", () => {
  const common = { researchIdeaHash: "shows", researchStageHash: "current" };
  const result = compileEvidenceLadderContext({
    messages: [
      { role: "user", id: "old", content: "I used to binge fantasy series with friends.", ...common },
      { role: "user", id: "preference-update", content: "Lately I've found myself drifting away from fantasy. Now I'm really into hard sci-fi shows and theoretical physics discussions with friends.", ...common },
      { role: "user", id: "workshop-update", content: "I took a hands-on film workshop instead of theory, and each session was engaging.", ...common },
      { role: "user", id: "collection", content: "I added a rare film item to my memorabilia collection.", ...common },
    ],
    query: "My friends and I are planning a weekend marathon. What shows fit our taste?",
    budget: 1600,
    activeContext: { ideaHash: "shows", stageHash: "current" },
  });
  assert.equal(result.manifest.profile.personalization, true);
  assert.equal(result.manifest.ladder.shadowedSupersededUserBlocks, 0);
  assert.match(result.context, /really into hard sci-fi/);
});
