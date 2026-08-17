import { createHash } from "node:crypto";

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

function limited(values, cap) {
  return new Set([...values].slice(0, cap));
}

function features(value, cap = 64) {
  const text = normalize(value);
  // Keep standalone numbers: Day 1 vs Day 2, route/version identifiers and
  // experiment indices are often the only feature that disambiguates scope.
  const latin = text.match(/[a-z_./:%+-][a-z0-9_./:%+-]+|\d+(?:\.\d+)?%?/g) || [];
  const cjkRuns = text.match(/[\u3400-\u9fff]{2,}/g) || [];
  const cjk = cjkRuns.flatMap((run) => {
    const out = [];
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
    return out;
  });
  const bigrams = [];
  for (let i = 0; i < latin.length - 1; i += 1) bigrams.push(`${latin[i]}\0${latin[i + 1]}`);
  return limited([...latin, ...cjk, ...bigrams], cap);
}

function identifiers(value, cap = 16) {
  const text = String(value || "");
  return limited([
    ...(text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || []).map((item) => item.toLowerCase()),
    ...(text.match(/\b\d+(?:\.\d+)?%?\b/g) || []),
  ], cap);
}

function temporalFeatures(value, cap = 8) {
  const text = normalize(value);
  return limited(text.match(/\b(?:19|20)\d{2}(?:[-/]\d{1,2})?(?:[-/]\d{1,2})?\b|\b(?:today|yesterday|tomorrow|last|next)\b|今天|昨天|明天|上(?:周|月|年)|下(?:周|月|年)/g) || [], cap);
}

/** Opaque stable code. The source text is never injected through this code. */
export function hexLabel(group, value) {
  return `${group}:${createHash("sha256").update(`${group}\0${normalize(value)}`).digest("hex").slice(0, 16)}`;
}

function addPosting(postings, code, id) {
  let ids = postings.get(code);
  if (!ids) postings.set(code, ids = new Set());
  ids.add(id);
}

export class CompactHexIndex {
  constructor() {
    this.postings = new Map();
    this.documents = new Map();
    this.sourceUnits = new Map();
  }

  addRecord(record) {
    const started = performance.now();
    let added = 0;
    for (const claim of record?.claims || []) {
      const id = String(claim.claimId || hexLabel("D", `${record.id}\0${claim.quote}`));
      if (this.documents.has(id)) continue;
      const source = String(claim.sourceUnitId || record.id || "");
      this.documents.set(id, claim);
      this.sourceUnits.set(id, source);
      const channels = [
        ["L", features(`${claim.claim || ""}\n${claim.quote || ""}`, 64)],
        ["C", features((claim.retrievalCues || []).join("\n"), 48)],
        ["S", features((claim.thematicScopes || []).join("\n"), 24)],
        ["V", features((claim.eventTypes || []).join("\n"), 12)],
        ["K", features((claim.entityRoles || []).join("\n"), 24)],
        ["E", limited([...(claim.entities || []).flatMap((item) => [...features(item, 8)]), ...identifiers(`${claim.claim || ""}\n${claim.quote || ""}`, 16)], 16)],
        ["T", new Set([...temporalFeatures(claim.memoryDate), ...temporalFeatures(`${claim.claim || ""}\n${claim.quote || ""}`)])],
      ];
      for (const [group, values] of channels) for (const value of values) addPosting(this.postings, hexLabel(group, value), id);
      added += 1;
    }
    return { added, ms: performance.now() - started };
  }

  query(query, { limit = 12, maxPostingVisits = 50_000, maxDocumentFrequencyRatio = 0.2, minHighFrequencyDocuments = 32 } = {}) {
    const started = performance.now();
    const scores = new Map();
    const channelQueries = [
      ["L", features(query), 1],
      // Retrieval cues are encoded with the same text features as a future
      // query, so readable cue text need not remain in the online index.
      ["C", features(query), 1.35],
      ["S", features(query), 2.2],
      ["V", features(query), 1.7],
      ["K", features(query), 1.8],
      ["E", identifiers(query), 1.5],
      ["T", temporalFeatures(query), 1.4],
    ];
    const n = Math.max(1, this.documents.size);
    const postingQueries = [];
    for (const [group, values, weight] of channelQueries) {
      for (const value of values) {
        const ids = this.postings.get(hexLabel(group, value));
        if (!ids) continue;
        postingQueries.push({ ids, weight, group });
      }
    }
    // Rare-first traversal makes the work budget useful: discriminative labels
    // are consumed before high-frequency labels. A skipped common label can
    // only remove a weak ranking signal; it cannot invent or authorize a fact.
    postingQueries.sort((a, b) => a.ids.size - b.ids.size);
    let postingVisits = 0;
    let skippedHighFrequency = 0;
    const intentHits = new Map();
    for (const { ids, weight, group } of postingQueries) {
      if (n >= minHighFrequencyDocuments && ids.size >= minHighFrequencyDocuments && ids.size / n > maxDocumentFrequencyRatio) {
        skippedHighFrequency += 1;
        continue;
      }
      if (postingVisits + ids.size > maxPostingVisits) break;
      postingVisits += ids.size;
      const idf = Math.log(1 + n / ids.size);
        for (const id of ids) {
          scores.set(id, (scores.get(id) || 0) + weight * idf);
          if (group === "S" || group === "V" || group === "K") intentHits.set(id, (intentHits.get(id) || 0) + 1);
        }
    }
    const rows = [...scores].map(([id, score]) => ({ ...this.documents.get(id), score, intentHits: intentHits.get(id) || 0 }))
      // STITCH-style structure first, similarity second. With no contextual-
      // intent hit this degenerates exactly to the ordinary weighted-IDF rank.
      .sort((a, b) => b.intentHits - a.intentHits || b.score - a.score || String(a.claimId).localeCompare(String(b.claimId)))
      .slice(0, limit);
    return { rows, ms: performance.now() - started, candidates: scores.size, postingVisits, skippedHighFrequency };
  }

  stats() {
    let postingIds = 0;
    for (const ids of this.postings.values()) postingIds += ids.size;
    return { documents: this.documents.size, labels: this.postings.size, postingIds };
  }
}
