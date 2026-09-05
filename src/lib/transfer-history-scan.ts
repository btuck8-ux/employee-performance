/**
 * Repo-wide scanner behind the W1 transfer invariant (G2 2a, hardened per
 * Codex 2026-09-05): no code outside the recompute path may issue an
 * `.update()` on performance_records whose payload carries — or could
 * carry — `location_id`. Post-093, location_id is row identity; the only
 * legitimate stamping is the recompute asset's upsert-as-row-identity.
 *
 * This is deliberately a pure function over source text so the bypass
 * fixtures ship as ordinary unit tests. It walks the actual fluent chain
 * off `.from("performance_records")` (balanced parens, string- and
 * comment-aware, arbitrary whitespace, optional generic args), so it
 * neither crosses into another table's chain nor loses the chain after a
 * long argument. Payload rules, strict on purpose:
 *   - object literal containing `location_id`  → offence
 *   - object literal containing a spread       → offence (uninspectable)
 *   - any non-object-literal payload           → offence (uninspectable)
 * A legitimate new writer is added to the test's allowlist deliberately,
 * with review — never by making this scanner cleverer.
 */

export type ChainCall = { name: string; arg: string };

const FROM_RE = /\.\s*from\s*\(\s*["'`]performance_records["'`]\s*\)/g;

/** Index of the char AFTER the balanced close of the paren at `open`. */
function skipBalanced(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

function skipWsAndComments(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

/** Every fluent chain hanging off a performance_records from(), per file. */
export function performanceRecordsChains(src: string): ChainCall[][] {
  const chains: ChainCall[][] = [];
  for (const m of src.matchAll(FROM_RE)) {
    const calls: ChainCall[] = [];
    // position after from(...)'s balanced close
    let i = skipBalanced(src, src.indexOf("(", m.index), "(", ")");
    for (;;) {
      i = skipWsAndComments(src, i);
      if (src[i] !== ".") break;
      i = skipWsAndComments(src, i + 1);
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
      if (!id) break;
      i += id[0].length;
      i = skipWsAndComments(src, i);
      if (src[i] === "<") i = skipBalanced(src, i, "<", ">"); // dodge-proof: .update<T>(...)
      i = skipWsAndComments(src, i);
      if (src[i] !== "(") break;
      const argStart = i + 1;
      const end = skipBalanced(src, i, "(", ")");
      calls.push({ name: id[0], arg: src.slice(argStart, end - 1).trim() });
      i = end;
    }
    chains.push(calls);
  }
  return chains;
}

/** Human-readable offences in one file's source. Empty array = clean. */
export function findTransferRewriteOffences(src: string): string[] {
  const offences: string[] = [];
  for (const chain of performanceRecordsChains(src)) {
    for (const call of chain) {
      if (call.name !== "update") continue;
      if (!call.arg.startsWith("{")) {
        offences.push(
          `non-literal update payload (${call.arg.slice(0, 40)}…) on a performance_records chain — uninspectable, not allowed`
        );
      } else if (/\.\.\./.test(call.arg)) {
        offences.push(
          "update payload spreads another object on a performance_records chain — uninspectable, not allowed"
        );
      } else if (/\blocation_id\b/.test(call.arg)) {
        offences.push(
          "update payload carries location_id — a transfer must never re-attribute history"
        );
      }
    }
  }
  return offences;
}
