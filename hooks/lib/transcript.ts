/**
 * Transcript source — Claude Code's session JSONL turned into what the
 * lossless summary and session_recall are built from.
 *
 * The transcript file is append-only and keeps every row from before earlier
 * compactions, so the summary is rebuilt from the full history each time and
 * never merges an older summary. A block's `sourceIndex` is its 1-based line in
 * the file: stable across reads, and what `#N` refs in a summary point at.
 *
 * Telling the user's own words apart is the transcript's job here: a user row
 * carries `origin.kind` ("human", "peer", "task-notification", "plugin"),
 * `isMeta` for injected rows and `isCompactSummary` for a compaction summary.
 */

import type { NormalizedBlock } from "./types";
import { filterNoise } from "./filter-noise";
import { sanitize } from "./sanitize";

/** Opens every summary this mod writes, so a rebuild skips older ones. */
export const SUMMARY_MARK = "<lossless-compaction-summary>";

/** True for a summary this mod wrote, even when the engine wraps it in text of its own. */
export const isSummaryText = (text: string): boolean => text.slice(0, 500).includes(SUMMARY_MARK);

export interface SummarySource {
  /** Blocks for sections + transcript: real user text, assistant, tools. sourceIndex = transcript line. */
  blocks: NormalizedBlock[];
  /** The user's own messages, raw text (newlines kept), oldest first. */
  requests: string[];
  /** Assistant prose per message, raw text, oldest first. */
  reports: string[];
  /** Blocks of the kept tail (after the cut): newer truth, used only to spot what it replaces. */
  tail?: NormalizedBlock[];
}

/** One user or assistant row of the transcript, as the summary needs it. */
export interface Row {
  line: number;
  uuid: string;
  parent?: string;
  role: "user" | "assistant";
  isSidechain: boolean;
  /** Skipped from requests and blocks: injected, a compaction summary, ours. */
  isHidden: boolean;
  /** The user's own words (a typed prompt or a slash command). */
  isHuman: boolean;
  /** Who sent a non-human user row ("peer", "task-notification", ...). */
  originKind?: string;
  isToolResult: boolean;
  /** Same for a row and the copy the engine writes of it after a compaction. */
  copyKey: string;
  content: unknown;
}

interface Linked {
  uuid: string;
  parent?: string;
}

/** Parsed rows plus every uuid's parent, so lineage can pass through attachments. */
export interface Transcript {
  rows: Row[];
  links: Map<string, Linked>;
}

const ASK_TOOLS = /^(?:AskUserQuestion|ask_user|ask_user_question)$/i;
const COMMAND_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const LOCAL_OUTPUT_RE = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The user's own words, without the reminders the harness wraps around them. */
export const stripReminders = (text: string): string => text.replace(REMINDER_RE, "").trim();

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "tool_result") return textOf(part.content);
      if (part?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

/** A slash command row as the user typed it, or the text unchanged. */
export const commandText = (text: string): string => {
  const name = text.match(COMMAND_RE)?.[1];
  if (!name) return text;
  const args = text.match(COMMAND_ARGS_RE)?.[1]?.trim() ?? "";
  return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
};

/** Parses complete JSONL lines into rows and links; `firstLine` is the 1-based line of `lines[0]`. */
export function parseLines(lines: readonly string[], firstLine: number, into: Transcript): void {
  lines.forEach((raw, i) => {
    if (!raw) return;
    let entry: any;
    try {
      entry = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof entry?.uuid !== "string" || into.links.has(entry.uuid)) return;
    const parent = entry.parentUuid ?? entry.logicalParentUuid ?? undefined;
    into.links.set(entry.uuid, { uuid: entry.uuid, parent: typeof parent === "string" ? parent : undefined });
    if (entry.type !== "user" && entry.type !== "assistant") return;
    const content = entry.message?.content;
    const text = entry.type === "user" ? textOf(content) : "";
    const isOurs = isSummaryText(text);
    const isToolResult = Array.isArray(content) && content.some((p: any) => p?.type === "tool_result");
    const originKind = typeof entry.origin?.kind === "string" ? entry.origin.kind : undefined;
    const isHuman =
      entry.type === "user" &&
      !entry.isMeta &&
      !isToolResult &&
      !isOurs &&
      (originKind === "human" || (originKind === undefined && !LOCAL_OUTPUT_RE.test(text)));
    into.rows.push({
      line: firstLine + i,
      uuid: entry.uuid,
      parent: typeof parent === "string" ? parent : undefined,
      role: entry.type,
      isSidechain: Boolean(entry.isSidechain),
      isHidden: Boolean(entry.isMeta || entry.isCompactSummary || isOurs),
      isHuman,
      originKind: isHuman ? undefined : originKind,
      isToolResult,
      copyKey: `${entry.type}|${entry.timestamp ?? ""}|${entry.message?.id ?? ""}|${raw.length - raw.indexOf('"message"')}`,
      content,
    });
  });
}

/**
 * The rows of the active branch: walk parents back from the newest main row,
 * through attachments and compaction boundaries. Falls back to every main row
 * when the walk reaches too little of the file (a format it does not know).
 *
 * Parallel tool calls leave all but the last result off the parent chain (each
 * result's parent is its own tool_use row), so results hanging off the branch
 * join it. A compaction that keeps a tail writes those rows again after the
 * summary under new uuids; the copies are dropped so `#line` refs stay put.
 */
export function lineage(transcript: Transcript): Row[] {
  const main = transcript.rows.filter((r) => !r.isSidechain);
  const last = main.at(-1);
  if (!last) return [];
  const seen = new Set<string>();
  for (let cur: Linked | undefined = transcript.links.get(last.uuid); cur && !seen.has(cur.uuid); ) {
    seen.add(cur.uuid);
    cur = cur.parent ? transcript.links.get(cur.parent) : undefined;
  }
  const onBranch = main.filter((r) => seen.has(r.uuid) || (r.isToolResult && r.parent !== undefined && seen.has(r.parent)));
  const rows = onBranch.length >= main.length * 0.5 ? onBranch : main;
  const keys = new Set<string>();
  return rows.filter((r) => !keys.has(r.copyKey) && Boolean(keys.add(r.copyKey)));
}

/** Prose lines of a message: code fences dropped, each line sanitized. */
const linesOf = (text: string): string[] =>
  text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .split("\n")
    .map(sanitize)
    .filter(Boolean);

/** A row as normalized blocks; `toolNames` maps tool_use ids to tool names, filled as it goes. */
export function normalizeRow(row: Row, toolNames: Map<string, string>): NormalizedBlock[] {
  const at = row.line;
  const content = row.content;
  if (row.role === "assistant") {
    if (typeof content === "string") return content ? [{ kind: "assistant", text: sanitize(content), lines: linesOf(content), sourceIndex: at }] : [];
    if (!Array.isArray(content)) return [];
    const blocks: NormalizedBlock[] = [];
    for (const part of content as any[]) {
      if (part?.type === "text" && part.text) blocks.push({ kind: "assistant", text: sanitize(part.text), lines: linesOf(part.text), sourceIndex: at });
      else if (part?.type === "thinking") blocks.push({ kind: "thinking", text: sanitize(part.thinking ?? ""), redacted: false, sourceIndex: at });
      else if (part?.type === "redacted_thinking") blocks.push({ kind: "thinking", text: "", redacted: true, sourceIndex: at });
      else if (part?.type === "tool_use" || part?.type === "server_tool_use") {
        if (typeof part.id === "string") toolNames.set(part.id, part.name);
        blocks.push({ kind: "tool_call", name: String(part.name), args: part.input ?? {}, sourceIndex: at });
      }
    }
    return blocks;
  }

  if (row.isHidden) return [];
  if (Array.isArray(content) && content.some((p: any) => p?.type === "tool_result")) {
    return (content as any[])
      .filter((p) => p?.type === "tool_result")
      .map((p) => ({
        kind: "tool_result" as const,
        name: toolNames.get(p.tool_use_id) ?? "tool",
        text: sanitize(textOf(p.content)),
        isError: Boolean(p.is_error),
        sourceIndex: at,
      }));
  }
  const text = sanitize(textOf(content));
  if (!text) return [];
  if (row.isHuman) {
    const own = stripReminders(text);
    return own ? [{ kind: "user", text: commandText(own), sourceIndex: at }] : [];
  }
  // Another agent's message, a task notification, a plugin's note: context, not a request.
  return [{ kind: "tool_result", name: row.originKind ?? "message", text, isError: false, sourceIndex: at }];
}

/** Recall blocks over the active branch (or every main row for `scope: all`). */
export function recallBlocks(transcript: Transcript, scope: "lineage" | "all" = "lineage"): NormalizedBlock[] {
  const rows = scope === "all" ? transcript.rows.filter((r) => !r.isSidechain) : lineage(transcript);
  const toolNames = new Map<string, string>();
  return filterNoise(rows.flatMap((r) => normalizeRow(r, toolNames)));
}

/** The summary source from the active branch's rows before `endLine` (exclusive). */
export function collectSummarySource(transcript: Transcript, endLine = Infinity): SummarySource {
  const blocks: NormalizedBlock[] = [];
  const tail: NormalizedBlock[] = [];
  const requests: string[] = [];
  const reports: string[] = [];
  const toolNames = new Map<string, string>();

  for (const row of lineage(transcript)) {
    const normalized = normalizeRow(row, toolNames);
    if (row.line >= endLine) {
      tail.push(...normalized);
      continue;
    }
    if (row.role === "user" && row.isHuman && !row.isHidden) {
      const raw = commandText(stripReminders(textOf(row.content)));
      if (raw) requests.push(raw);
    } else if (row.role === "assistant") {
      const prose = normalized.filter((b) => b.kind === "assistant").map((b) => (b as { text: string }).text).join("\n").trim();
      if (prose) reports.push(prose);
    } else {
      // The user's answer to an agent question is the user's own decision.
      for (const b of normalized) if (b.kind === "tool_result" && ASK_TOOLS.test(b.name) && b.text) requests.push(b.text.trim());
    }
    blocks.push(...normalized);
  }
  return { blocks: filterNoise(blocks), requests, reports, tail: filterNoise(tail) };
}

const squash = (text: string): string => text.replace(/\s+/g, "");

/**
 * The line of the row that opens the kept tail: by its tool_use id, else by
 * its text (whitespace ignored, since rows and messages join blocks differently).
 */
export function findTailLine(
  transcript: Transcript,
  anchor: { toolUseId?: string; text: string; role?: "user" | "assistant" },
): number | undefined {
  const rows = lineage(transcript);
  if (anchor.toolUseId) {
    const row = rows.find(
      (r) => r.role === "assistant" && Array.isArray(r.content) && (r.content as any[]).some((p) => p?.id === anchor.toolUseId),
    );
    if (row) {
      // A response is one row per block: start at its first row (the text before the call).
      const at = rows.indexOf(row);
      const prev = rows[at - 1];
      return prev?.role === "assistant" && anchor.text && squash(textOf(prev.content)).length > 0 ? prev.line : row.line;
    }
  }
  const want = squash(anchor.text);
  if (!want) return undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (anchor.role && r.role !== anchor.role) continue;
    if (r.role === "user" && r.isHidden) continue;
    const have = squash(r.role === "assistant" ? assistantText(r.content) : textOf(r.content));
    if (have && (have === want || want.startsWith(have))) return r.line;
  }
  return undefined;
}

const assistantText = (content: unknown): string =>
  Array.isArray(content)
    ? (content as any[]).filter((p) => p?.type === "text").map((p) => p.text).join("")
    : typeof content === "string" ? content : "";
