/**
 * Reads the session's transcript file incrementally: each read takes only the
 * complete lines appended since the last one (`tail -n +K`, streamed, so no
 * 4 MiB read cap applies), and the parsed rows stay in the cache.
 */

import type { EngineInterface } from "claude-code";
import { parseLines, type Transcript } from "./transcript";

export interface ReaderCache {
  path?: string;
  sessionId?: string;
  lines: number;
  size: number;
  transcript: Transcript;
  /** The read in flight: concurrent callers share it, so no line is parsed twice. */
  pending?: Promise<Transcript | undefined>;
}

export const newReaderCache = (): ReaderCache => ({ lines: 0, size: 0, transcript: { rows: [], links: new Map() } });

function resetCache(cache: ReaderCache, sessionId?: string, path?: string): void {
  Object.assign(cache, newReaderCache(), { sessionId, path });
}

/** The transcript's path, found by the session id under the config dir's projects. */
export async function locateTranscript($: EngineInterface, cache: ReaderCache): Promise<string | undefined> {
  const id = await $.session.id();
  if (cache.path && cache.sessionId === id) return cache.path;
  resetCache(cache, id);
  const configDir = (await $.env.get("CLAUDE_CONFIG_DIR")) ?? `${await $.env.get("HOME")}/.claude`;
  const found = await $.process.run(["find", `${configDir}/projects`, "-maxdepth", "2", "-name", `${id}.jsonl`]);
  cache.path = found.stdout.split("\n").find(Boolean);
  return cache.path;
}

/** The transcript with every complete line read; undefined when the file cannot be found. */
export async function readTranscript($: EngineInterface, cache: ReaderCache): Promise<Transcript | undefined> {
  if (cache.pending) return cache.pending;
  cache.pending = readNewLines($, cache);
  try {
    return await cache.pending;
  } finally {
    cache.pending = undefined;
  }
}

async function readNewLines($: EngineInterface, cache: ReaderCache): Promise<Transcript | undefined> {
  const path = await locateTranscript($, cache);
  if (!path) return undefined;
  const stat = await $.fs.stat(path);
  // Rewritten or truncated: start over.
  if (stat.size < cache.size) resetCache(cache, cache.sessionId, path);
  if (stat.size === cache.size) return cache.transcript;

  let text = "";
  for await (const piece of $.process.spawn({ argv: ["tail", "-n", `+${cache.lines + 1}`, path] })) {
    if ("text" in piece && piece.stream === "stdout") text += piece.text;
  }
  const segments = text.split("\n");
  // The last segment is "" after a final newline, else a line still being written.
  const complete = segments.slice(0, -1);
  parseLines(complete, cache.lines + 1, cache.transcript);
  cache.lines += complete.length;
  const partial = segments.at(-1) ?? "";
  cache.size = stat.size - new TextEncoder().encode(partial).byteLength;
  return cache.transcript;
}
