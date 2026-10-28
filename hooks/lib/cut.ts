/**
 * Where the kept tail starts in the conversation being compacted.
 *
 * Keeps the last N user turns (keep:N), grows a tiny default tail (smart keep),
 * and re-cuts a tail that is too large on a token budget. A tail may open on a
 * user message without tool results or on an assistant message (the summary,
 * a user message, goes in front of it), never on a tool-result carrier, which
 * would orphan its tool_use.
 */

import type { SessionMessage } from "claude-code";
import { isSummaryText } from "./transcript";

export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;
export const OVERSIZED_TAIL_FACTOR = 2.5;
/** The tail must leave room for the system prompt, the summary and new turns. */
export const TAIL_WINDOW_LIMIT = 0.4;
export const TAIL_WINDOW_SHARE = 0.25;

export interface CutOptions {
  /** keep:N as typed; undefined for the default (1, smart keep may grow it). */
  keepUserTurns?: number;
  smartKeepTail: boolean;
  charsPerToken: number;
  /** The context window in tokens, when known. */
  window?: number;
}

export interface Cut {
  /** Index of the first kept message; messages.length keeps none. */
  index: number;
  keptUserTurns: number;
  totalUserTurns: number;
  smartFromKeep?: number;
  budgetCut?: "no_anchor" | "oversized_tail";
  keptTokens: number;
}

export const isOurSummary = (m: SessionMessage): boolean => m.role === "user" && isSummaryText(m.text);

/** A user turn opens here: a user message that carries no tool results and is not a summary. */
export const isUserStart = (m: SessionMessage): boolean =>
  m.role === "user" && !m.toolResults?.length && m.text.trim().length > 0 && !isOurSummary(m);

const isValidStart = (m: SessionMessage): boolean => m.role === "assistant" || isUserStart(m);

export const messageChars = (m: SessionMessage): number =>
  m.text.length +
  m.toolUses.reduce((n, t) => n + JSON.stringify(t.input ?? {}).length, 0) +
  (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0);

export function findCut(messages: readonly SessionMessage[], opts: CutOptions): Cut {
  const tokens = messages.map((m) => Math.ceil(messageChars(m) / opts.charsPerToken));
  const tailTokens = (from: number) => tokens.slice(from).reduce((a, b) => a + b, 0);
  // Never keep an older summary in the tail: it is rebuilt from the transcript.
  const floor = messages.reduce((at, m, i) => (isOurSummary(m) ? i + 1 : at), 0);
  const starts = messages.map((m, i) => (i >= floor && isUserStart(m) ? i : -1)).filter((i) => i >= 0);
  const explicit = opts.keepUserTurns !== undefined;
  const baseKeep = opts.keepUserTurns ?? 1;
  const startFor = (keep: number): number | undefined => (keep <= 0 ? messages.length : starts[starts.length - keep]);

  let keep = baseKeep;
  if (!explicit && opts.smartKeepTail) {
    const base = startFor(keep);
    if (base !== undefined && tailTokens(base) <= MIN_SMART_TAIL_TOKENS) {
      while (keep < starts.length && tailTokens(startFor(keep + 1)!) <= MAX_SMART_TAIL_TOKENS) keep++;
    }
  }

  const budgetIndex = (maxTokens: number): number | undefined => {
    let acc = 0;
    for (let i = messages.length - 1; i >= floor; i--) {
      acc += tokens[i]!;
      if (acc < maxTokens) continue;
      for (let j = Math.max(i, floor); j < messages.length; j++) if (isValidStart(messages[j]!)) return j;
      return undefined;
    }
    return undefined;
  };

  let index = startFor(keep);
  let budgetCut: Cut["budgetCut"];
  if (index === undefined) {
    index = budgetIndex(MAX_SMART_TAIL_TOKENS) ?? messages.length;
    budgetCut = "no_anchor";
  }

  const recut = (maxTokens: number, limit: number) => {
    if (tailTokens(index!) <= limit) return;
    const at = budgetIndex(maxTokens);
    if (at !== undefined && at > index!) {
      index = at;
      budgetCut = "oversized_tail";
    }
  };
  if (!explicit) recut(MAX_SMART_TAIL_TOKENS, MAX_SMART_TAIL_TOKENS * OVERSIZED_TAIL_FACTOR);
  if (opts.window && opts.window > 0) recut(Math.floor(opts.window * TAIL_WINDOW_SHARE), Math.floor(opts.window * TAIL_WINDOW_LIMIT));

  // Something must be summarized: a cut at the floor would compact nothing.
  if (index <= floor) index = budgetIndex(Math.floor(tailTokens(floor) / 2)) ?? messages.length;
  if (index <= floor) index = messages.length;

  return {
    index,
    keptUserTurns: starts.filter((i) => i >= index!).length,
    totalUserTurns: starts.length,
    smartFromKeep: keep !== baseKeep ? baseKeep : undefined,
    budgetCut,
    keptTokens: tailTokens(index),
  };
}
