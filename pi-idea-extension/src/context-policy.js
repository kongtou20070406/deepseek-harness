const GiB = 1024 * 1024 * 1024;

function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Every context-assembly constant that can change recall, token cost, or
 * retention lives here. Hard signals remain lexicographic in the compiler;
 * these numeric weights only order candidates inside the same eligibility
 * class.
 */
export const CONTEXT_POLICY = frozen({
  schema: 1,
  version: "pi-idea-context-policy-v2",
  fragmentation: {
    targetTokens: 384,
    hardTokens: 768,
    overlapTokens: 0,
    boundaryOrder: ["paragraph", "line", "sentence", "whitespace", "hard-slice"],
  },
  ingestion: {
    // Background work still shares Pi's JS thread. Small yielding batches keep
    // each synchronous SQLite slice below the interactive-loop budget.
    batchEntries: 8,
  },
  retrieval: {
    queryTermLimit: 12,
    returnedCandidateLimit: 24,
    candidateMultiplier: 3,
    maxPositiveRoots: 4,
    maxOptionalRoots: 3,
    multiTermMinimum: 2,
    relativeLexicalFloor: 0.35,
    absoluteLexicalFloor: 0.1,
    // Authority-bearing user updates are scarce but disproportionately costly
    // to miss. They are recovered through a separate relation channel before
    // ordinary token-budget packing.
    maxAuthorityUpdateRoots: 2,
    maxAuthorityBridgeRoots: 2,
    authorityRelationMinimum: 1,
  },
  ranking: {
    lexical: 1.0,
    authority: 0.25,
    sameIdea: 0.35,
    differentIdea: -0.15,
    sameStage: 0.25,
    differentStage: -0.10,
    optionalHeat: 0.15,
    optionalReranker: 0.35,
    authorityBySource: {
      tool: 1.0,
      user: 0.9,
      model: 0.1,
      unknown: 0.0,
    },
  },
  watermarks: {
    softFraction: 0.60,
    hardFraction: 0.85,
  },
  retention: {
    // Raw Pi sessions are durable by default. 100 GiB only triggers a future
    // capacity review; it never authorizes deletion. Cleanup is user-triggered.
    automaticCleanup: false,
    capacityReviewBytes: 100 * GiB,
    softLogicalBytes: 100 * GiB,
    hardLogicalBytes: 120 * GiB,
    minInactiveDays: 30,
    recentAccessDays: 30,
    keepRecentSessions: 8,
    cleanupIntervalHours: 24,
    maxDeleteBlocksPerRun: 5000,
    maxAuditRuns: 128,
  },
  obelisk: {
    mode: "explicit-gap-compatibility-only",
    maxEvidenceRows: 8,
    maxSnippetCharsForPlanning: 300,
    acceptedContentTypes: ["text"],
  },
});
