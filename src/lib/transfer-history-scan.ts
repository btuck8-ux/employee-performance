/**
 * Repo-wide scanner behind the W1 transfer invariant (G2 2a, hardened per
 * Codex 2026-09-05 rounds 1+2): no code outside the recompute path may
 * issue an `.update()` on performance_records whose payload carries — or
 * could carry — `location_id`. Post-093, location_id is row identity; the
 * only legitimate stamping is the recompute asset's upsert-as-row-identity.
 *
 * Mechanism: one tokenizer pass produces two same-length views of the
 * source with aligned offsets —
 *   noComments : comments blanked to spaces, strings intact
 *   masked     : comments AND string/template contents blanked (quotes
 *                kept), template interpolations blanked wholesale, regex
 *                literals blanked
 * Chain discovery runs on noComments (so `from(/* t *​/ "performance_records")`
 * is found and commented-out code is NOT); all balancing, chain-walking and
 * payload inspection run on masked text, which is structurally inert — no
 * paren/brace/backtick inside any string, template, comment or regex can
 * confuse it. Payload rules, strict on purpose:
 *   - not a single object literal spanning the whole argument → offence
 *   - object literal with a spread or a computed key         → offence
 *   - object literal carrying a location_id key              → offence
 * A legitimate new writer is added to the test's allowlist deliberately,
 * with review — never by making this scanner cleverer.
 */

export type ChainCall = { name: string; arg: string };

/** Chars after which a `/` starts a regex literal, not division. */
const REGEX_PRECEDER = /[=([{,;:!&|?+\-*%^~<>]/;

function buildViews(src: string): { noComments: string; masked: string } {
  const nc = src.split("");
  const mk = src.split("");
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== "\n") arr[k] = " ";
  };

  let i = 0;
  let lastCode = ""; // last significant char outside strings/comments

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(nc, start, i);
      blank(mk, start, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, src.length);
      blank(nc, start, i);
      blank(mk, start, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++;
        i++;
      }
      i = Math.min(i + 1, src.length);
      blank(mk, start + 1, i - 1); // keep the quotes, blank the content
      lastCode = ch;
      continue;
    }
    if (ch === "`") {
      // template literal: blank EVERYTHING to the matching close in masked,
      // including interpolation code (structurally inert is the goal);
      // noComments keeps it verbatim.
      const start = i;
      i++;
      let depth = 0; // ${ } nesting inside this template
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          else if (src[i] === "`") {
            // nested template inside interpolation — treat as plain char;
            // masking everything makes precise nesting irrelevant
          }
          i++;
          continue;
        }
        if (src[i] === "`") break;
        i++;
      }
      i = Math.min(i + 1, src.length);
      blank(mk, start + 1, i - 1);
      lastCode = "`";
      continue;
    }
    if (ch === "/" && (lastCode === "" || REGEX_PRECEDER.test(lastCode))) {
      // heuristic regex literal: skip to unescaped '/', honoring [ ] classes
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "\n") break; // not a regex after all — bail
        i++;
      }
      if (src[i] === "/") {
        i++;
        while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
        blank(mk, start + 1, i);
        lastCode = "/";
        continue;
      }
      i = start + 1; // division — fall through
      lastCode = "/";
      continue;
    }
    if (!/\s/.test(ch)) lastCode = ch;
    i++;
  }
  return { noComments: nc.join(""), masked: mk.join("") };
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** On MASKED text: index after the balanced close of the opener at `open`. */
function skipBalancedMasked(masked: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (openCh === "<" && ch === "=" && masked[i + 1] === ">") {
      i++; // an arrow `=>` inside a generic — its `>` is not a closer
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

/**
 * Every fluent chain hanging off a performance_records from().
 * `arg` slices come from the UNMASKED-but-comment-free view; a parallel
 * maskedArg is used for structural payload checks.
 */
export function performanceRecordsChains(
  src: string
): Array<Array<ChainCall & { maskedArg: string }>> {
  const { noComments, masked } = buildViews(src);
  const chains: Array<Array<ChainCall & { maskedArg: string }>> = [];
  // Discovery on noComments (comments can't hide the call; commented-out
  // code was blanked). The string content survives in noComments, so the
  // table name is visible; whitespace where comments were is tolerated.
  const fromRe = /\.\s*from\s*\(\s*["'`]performance_records["'`]\s*\)/g;
  for (const m of noComments.matchAll(fromRe)) {
    const calls: Array<ChainCall & { maskedArg: string }> = [];
    let i = skipBalancedMasked(masked, noComments.indexOf("(", m.index), "(", ")");
    for (;;) {
      i = skipWs(masked, i);
      if (masked[i] !== ".") break;
      i = skipWs(masked, i + 1);
      const id = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i, i + 80));
      if (!id) break;
      i += id[0].length;
      i = skipWs(masked, i);
      if (masked[i] === "<") i = skipBalancedMasked(masked, i, "<", ">");
      i = skipWs(masked, i);
      if (masked[i] !== "(") break;
      const argStart = i + 1;
      const end = skipBalancedMasked(masked, i, "(", ")");
      calls.push({
        name: id[0],
        arg: noComments.slice(argStart, end - 1).trim(),
        maskedArg: masked.slice(argStart, end - 1),
      });
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
      const masked = call.maskedArg;
      const t = masked.trim();
      // The WHOLE argument must be exactly one object literal: first
      // non-space char `{` whose balanced close is the final non-space
      // char. `{} && payload`, `{...}, opts`, calls, variables all fail.
      const braceAt = masked.indexOf("{");
      // skipBalancedMasked returns the index AFTER the close brace; the
      // literal spans the whole argument iff that equals the length of the
      // argument with trailing whitespace removed.
      const wholeLiteral =
        t.startsWith("{") &&
        skipBalancedMasked(masked, braceAt, "{", "}") === masked.trimEnd().length;
      if (!wholeLiteral) {
        offences.push(
          `update payload is not a single object literal (${call.arg.slice(0, 40)}…) on a performance_records chain — uninspectable, not allowed`
        );
        continue;
      }
      if (/\.\.\./.test(masked)) {
        offences.push(
          "update payload spreads another object on a performance_records chain — uninspectable, not allowed"
        );
      } else if (/[{,]\s*\[/.test(masked)) {
        offences.push(
          "update payload uses a computed key on a performance_records chain — uninspectable, not allowed"
        );
      } else if (/\blocation_id\b/.test(masked)) {
        offences.push(
          "update payload carries location_id — a transfer must never re-attribute history"
        );
      }
    }
  }
  return offences;
}
