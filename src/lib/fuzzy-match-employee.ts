/**
 * Fuzzy-match a typed-by-an-employee name (which may be lowercase, missing
 * surname, or have typos) against the canonical roster from the database.
 *
 * Stages, in order — first match wins:
 *   1. Exact (case-insensitive)
 *   2. First-name only (typed is one token; matches uniquely on first name)
 *   3. Token containment (every typed token appears among the candidate's tokens)
 *   4. Levenshtein distance ≤ max(2, 25% of typed length)
 *
 * Ambiguous matches (multiple equally-good hits at stage 2 or 3) return null
 * with `candidates_considered` populated so the caller can warn the user.
 */

export interface EmployeeCandidate {
  id: string;
  employee_name: string;
}

export type MatchConfidence =
  | "exact"
  | "first_name"
  | "token_containment"
  | "levenshtein"
  | "ambiguous"
  | "none";

export interface FuzzyMatchResult {
  match: EmployeeCandidate | null;
  confidence: MatchConfidence;
  candidates_considered?: EmployeeCandidate[];
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

export function fuzzyMatchEmployee(
  typed: string,
  candidates: EmployeeCandidate[]
): FuzzyMatchResult {
  const t = normalize(typed);
  if (!t) return { match: null, confidence: "none" };

  // Stage 1: exact (case-insensitive)
  const exact = candidates.find((c) => normalize(c.employee_name) === t);
  if (exact) return { match: exact, confidence: "exact" };

  const typedTokens = tokenize(t);

  // Stage 2: first-name only (typed is a single token)
  if (typedTokens.length === 1) {
    const first = candidates.filter((c) => tokenize(c.employee_name)[0] === typedTokens[0]);
    if (first.length === 1) return { match: first[0], confidence: "first_name" };
    if (first.length > 1)
      return { match: null, confidence: "ambiguous", candidates_considered: first };
  }

  // Stage 3: token containment — every typed token appears among the candidate's tokens
  const contained = candidates.filter((c) => {
    const cTokens = tokenize(c.employee_name);
    return typedTokens.every((t) => cTokens.includes(t));
  });
  if (contained.length === 1) return { match: contained[0], confidence: "token_containment" };
  if (contained.length > 1)
    return { match: null, confidence: "ambiguous", candidates_considered: contained };

  // Stage 4: Levenshtein on full strings
  let best: { c: EmployeeCandidate; dist: number } | null = null;
  for (const c of candidates) {
    const dist = levenshtein(t, normalize(c.employee_name));
    if (!best || dist < best.dist) best = { c, dist };
  }
  const threshold = Math.max(2, Math.floor(t.length * 0.25));
  if (best && best.dist <= threshold) return { match: best.c, confidence: "levenshtein" };

  return { match: null, confidence: "none" };
}
