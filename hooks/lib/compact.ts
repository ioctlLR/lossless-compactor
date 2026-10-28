/**
 * The lossless compaction itself: the kept tail from the conversation being
 * compacted, the summary rebuilt from the full transcript up to that tail.
 */

import type { SessionMessage } from "claude-code";
import { findCut, messageChars, type Cut } from "./cut";
import { autoBudgetTokens, buildLosslessSummary } from "./summarize";
import { calibrateCharsPerToken } from "./token-estimate";
import { collectSummarySource, findTailLine, SUMMARY_MARK, type Transcript } from "./transcript";

const SUMMARY_CHARS_PER_TOKEN = 4;
/** Small-context models: the summary may not crowd out the work (≤8% of the window). */
const SUMMARY_WINDOW_SHARE = 0.08;

export interface CompactArgs {
  /** keep:N, when given. */
  keepUserTurns?: number;
  /** method:llm / method:lossless, when given. */
  method?: "lossless" | "llm";
  /** What is left once the tokens above are taken out (the llm method's focus). */
  focus: string;
}

/** Reads `keep:N` and `method:<m>` tokens anywhere in /compact's text. */
export function parseCompactArgs(instructions?: string): CompactArgs {
  let text = instructions ?? "";
  let keepUserTurns: number | undefined;
  let method: CompactArgs["method"];
  text = text.replace(/(^|\s)keep:(\d+)(?=\s|$)/g, (_, lead: string, n: string) => {
    keepUserTurns = Number(n);
    return lead;
  });
  text = text.replace(/(^|\s)method:(lossless|llm)(?=\s|$)/g, (_, lead: string, m: "lossless" | "llm") => {
    method = m;
    return lead;
  });
  return { keepUserTurns, method, focus: text.trim() };
}

export interface LosslessOptions {
  keepUserTurns?: number;
  smartKeepTail: boolean;
  summaryBudgetTokens: number;
  window?: number;
  tokensBefore?: number;
  cwd?: string;
}

export interface LosslessResult {
  messages: SessionMessage[];
  cut: Cut;
  summaryTokens: number;
  tokensAfterEst: number;
  sections: string[];
  /** False when the tail's first row was not found in the transcript (the summary then covers it too). */
  isTailAnchored: boolean;
}

export function compactLossless(
  transcript: Transcript,
  messages: readonly SessionMessage[],
  opts: LosslessOptions,
): LosslessResult {
  const chars = messages.reduce((n, m) => n + messageChars(m), 0);
  const { charsPerToken } = calibrateCharsPerToken(chars, opts.tokensBefore);
  const cut = findCut(messages, {
    keepUserTurns: opts.keepUserTurns,
    smartKeepTail: opts.smartKeepTail,
    charsPerToken,
    window: opts.window,
  });
  const tail = messages.slice(cut.index);

  // Anchor on the first tail message the transcript can be matched by (a
  // thinking-only one has nothing to match); the rows before it are summarized.
  let endLine: number | undefined;
  for (const m of tail.slice(0, 8)) {
    endLine = findTailLine(transcript, m.role === "assistant" && m.toolUses[0]
      ? { toolUseId: m.toolUses[0].tool_use_id, text: m.text }
      : { text: m.text, role: m.role });
    if (endLine !== undefined) break;
  }
  const first = tail[0];

  const source = collectSummarySource(transcript, endLine ?? Infinity);
  const wanted = opts.summaryBudgetTokens > 0 ? opts.summaryBudgetTokens : autoBudgetTokens(source.blocks.length);
  const budgetTokens = opts.window
    ? Math.min(wanted, Math.max(800, Math.floor(opts.window * SUMMARY_WINDOW_SHARE)))
    : wanted;
  const summary = buildLosslessSummary({
    source,
    budgetChars: budgetTokens * SUMMARY_CHARS_PER_TOKEN,
    cwd: opts.cwd,
  });

  const text =
    `${SUMMARY_MARK}\n` +
    "This conversation was compacted. Below is a summary of the earlier part, " +
    "condensed without a model call from the full session history.\n\n" +
    `${summary.text || "(Nothing earlier to summarize.)"}\n` +
    "</lossless-compaction-summary>";
  const summaryTokens = Math.ceil(text.length / SUMMARY_CHARS_PER_TOKEN);

  return {
    messages: [{ role: "user", text, toolUses: [] }, ...tail],
    cut,
    summaryTokens,
    tokensAfterEst: summaryTokens + cut.keptTokens,
    sections: summary.sections,
    isTailAnchored: !first || endLine !== undefined,
  };
}
