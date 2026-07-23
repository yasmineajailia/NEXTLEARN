/**
 * remediationTargets.ts
 *
 * Turns a FAILED quiz into a ranked list of sous-acquis to review, driven by the
 * student's actual responses.
 *
 * Two signals are combined:
 *
 *   1. Response-driven — each wrong question can carry a `relatedSubAcquis` tag
 *      (which concept it tests). A wrong tagged question is direct evidence the
 *      student is weak on that specific sous-acquis, so it is weighted highest.
 *   2. Prerequisite fallback — the failed sous-acquis's `depends_on` chain (two
 *      levels, matching the previous client behaviour). This is the safety net so
 *      a student never sees an empty panel, and it is the ONLY source until quiz
 *      questions are tagged at generation time.
 *
 * When no question is tagged, the output is exactly the old 2-level prerequisite
 * list — no regression. As questions gain tags, the concepts a student actually
 * missed float to the top.
 */

import type { SkillsJson } from "./skill-recommender";

export type RemediationTarget = {
  /** Sous-acquis id, e.g. "1.2". */
  id: string;
  /** Human-readable French title from the graph, or the id when unknown. */
  title: string;
  /** Ranking weight — higher = more strongly recommended. */
  weight: number;
  /** True when a wrong answer pointed here; false when it is a graph prerequisite. */
  fromResponses: boolean;
};

/** Weight a wrong tagged question contributes to its concept (above a prerequisite). */
const RESPONSE_WEIGHT = 2;
/** Weight a graph prerequisite contributes. */
const PREREQ_WEIGHT = 1;

/** Collects `depends_on` prerequisites up to `depth` levels, breadth-first. */
function collectPrerequisites(graph: SkillsJson, startId: string, depth: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>([startId]);
  let frontier = [startId];

  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const raw of graph[id]?.depends_on ?? []) {
        const dep = String(raw).trim();
        if (graph[dep] && !seen.has(dep)) {
          seen.add(dep);
          out.push(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Computes the ranked remediation targets for a failed quiz.
 *
 * @param params.failedSubAcquisId - the sous-acquis whose quiz was failed.
 * @param params.wrongQuestionIndexes - indexes (into the quiz) the student missed.
 * @param params.questionTags - `relatedSubAcquis` per question index (null when untagged).
 * @param params.graph - the recommendation graph.
 * @param params.limit - max targets to return (default 5).
 * @param params.fallbackDepth - prerequisite depth for the fallback (default 2).
 * @returns targets sorted by weight (response-driven first), capped to `limit`.
 */
export function computeRemediationTargets(params: {
  failedSubAcquisId: string;
  wrongQuestionIndexes: number[];
  questionTags: Array<string | null | undefined>;
  graph: SkillsJson;
  limit?: number;
  fallbackDepth?: number;
}): RemediationTarget[] {
  const { failedSubAcquisId, wrongQuestionIndexes, questionTags, graph, limit = 5, fallbackDepth = 2 } = params;

  const weights = new Map<string, number>();
  const fromResponses = new Set<string>();

  // 1) Response-driven targets — a wrong question with a valid, different tag.
  for (const qi of wrongQuestionIndexes) {
    const tag = questionTags[qi];
    if (tag && graph[tag] && tag !== failedSubAcquisId) {
      weights.set(tag, (weights.get(tag) ?? 0) + RESPONSE_WEIGHT);
      fromResponses.add(tag);
    }
  }

  // 2) Prerequisite fallback — always added, so the panel is never empty and so
  //    untagged quizzes still behave like the previous 2-level depends_on list.
  for (const id of collectPrerequisites(graph, failedSubAcquisId, fallbackDepth)) {
    if (id === failedSubAcquisId) continue;
    weights.set(id, (weights.get(id) ?? 0) + PREREQ_WEIGHT);
  }

  return [...weights.entries()]
    .map(([id, weight]) => ({
      id,
      title: graph[id]?.title ?? id,
      weight,
      fromResponses: fromResponses.has(id)
    }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
