"use client";
import { useState } from "react";

/**
 * Truncate long free-text (review bodies, tattle comments) with an inline
 * expand/collapse toggle. Client module on purpose — it owns state. Server
 * pages RENDER it as a component; they must never import-and-call anything
 * from here (server/client boundary contract, 2026-08-17 scar).
 */
export function ExpandableText({
  text,
  clampChars = 160,
}: {
  text: string;
  clampChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= clampChars) return <span>{text}</span>;
  return (
    <span>
      {expanded ? text : `${text.slice(0, clampChars).trimEnd()}…`}{" "}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-ikes-green-dark underline hover:text-ikes-green whitespace-nowrap"
      >
        {expanded ? "less" : "more"}
      </button>
    </span>
  );
}
