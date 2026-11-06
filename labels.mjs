// Label ids a question names. Shared by the selection page (badges) and the
// report skill's RetailerIntegration lookup (label-ri.mjs).

const GENERATION = /Target LabelId:\s*(\d+)/i;
const MENTION = /label\s*-?\s*id\s*:?\s*(\d+)/gi;

/** Is this a labelizer generation call (the /from-pdf prompt)? */
export const isLabelizerGeneration = (question) => GENERATION.test(question ?? "");

/** The label ids a question names: `[{ labelId, source }]`, each id once. */
export function labelRefs(question) {
  const generation = GENERATION.exec(question ?? "");
  if (generation) return [{ labelId: generation[1], source: "generation" }];
  const ids = new Set([...String(question ?? "").matchAll(MENTION)].map((m) => m[1]));
  return [...ids].map((labelId) => ({ labelId, source: "question" }));
}
