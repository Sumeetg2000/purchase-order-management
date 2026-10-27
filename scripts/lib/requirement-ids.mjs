// The ID patterns the ban, the commit rule and the traceability check share (ADR-0013).
// Tier names like T1 and T2 have fewer than three digits, so they never match.

/** A task number: T followed by exactly three digits. */
export const TASK_ID = /\bT\d{3}\b/g;

/** A requirement ID: FR-<AREA>-NN or NFR-<AREA>-NN. */
export const REQUIREMENT_ID = /\bN?FR-[A-Z]+-\d+\b/g;

/** Every requirement ID in a piece of text, in order of appearance. */
export function requirementIds(text) {
  return [...text.matchAll(REQUIREMENT_ID)].map((m) => m[0]);
}

/** Every task or requirement ID in a piece of text, with its offset. */
export function bannedIds(text) {
  return [...text.matchAll(TASK_ID), ...text.matchAll(REQUIREMENT_ID)]
    .map((m) => ({ match: m[0], index: m.index }))
    .sort((a, b) => a.index - b.index);
}
