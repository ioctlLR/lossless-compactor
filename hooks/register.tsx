/**
 * lossless-compactor — zero-LLM compaction for Claude Code, ported from
 * @pi-unipi/compactor (MIT, Neuron Mr White).
 *
 * Every compaction of the main conversation (auto, /compact, a plugin's)
 * passes the session.compact hook: the lossless method answers it with a
 * summary rebuilt from the full transcript file plus the kept tail; the llm
 * method hands it to Claude Code's own summarizer. session_recall searches the
 * full transcript, and /compactor-stats opens a pane with what compaction did.
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CompactionRecord, CompactorStats } from '../types'
import { compactLossless, parseCompactArgs } from './lib/compact'
import { setSessionCwd } from './lib/paths'
import { newReaderCache, readTranscript } from './lib/reader'
import { recallBlocks } from './lib/transcript'
import { vccRecall } from './lib/vcc-recall'

const PLUGIN = 'lossless-compactor'
const PANE = 'compactor-stats'
const RECALL = 'mcp__lossless-compactor__session_recall'
const STORE_KEY = 'stats'
const STORED_SESSIONS = 30
const EMPTY: CompactorStats = { compactions: [], recallQueries: 0 }

const stats = atom({ plugin: 'lossless-compactor', key: 'stats' } as const, EMPTY)

type Options = {
  method: 'lossless' | 'llm'
  autoCompactWindow: number
  summaryBudgetTokens: number
  smartKeepTail: boolean
  notify: boolean
}

const RECALL_DESCRIPTION =
  'Search the full history of this session, including messages that compaction removed from context. ' +
  'Use it whenever a detail from earlier is missing. Plain keywords work best; a regex works too. ' +
  '`#123` refs in a compaction summary are transcript lines: pass them in `expand` for full content, ' +
  'or query `#123:path` to read the file content of that tool call. `mode: "touched"` lists the files worked on. ' +
  '`scope: "all"` also searches rewound branches.'

const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Keywords or a regex; `#N:path` drills into a tool call.' },
    expand: { type: 'array', items: { type: 'integer' }, description: 'Transcript lines to return in full.' },
    mode: { type: 'string', enum: ['search', 'touched'] },
    scope: { type: 'string', enum: ['lineage', 'all'] },
    page: { type: 'integer', minimum: 1 },
  },
}

const fmt = (n?: number): string =>
  n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

/** Keeps this session's stats across sessions, for the last STORED_SESSIONS sessions. */
async function persist($: EngineInterface, value: CompactorStats): Promise<void> {
  const id = await $.session.id()
  const all = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, CompactorStats>
  delete all[id]
  all[id] = value
  const ids = Object.keys(all)
  for (const old of ids.slice(0, Math.max(0, ids.length - STORED_SESSIONS))) delete all[old]
  await $.store.set(STORE_KEY, all)
}

async function record($: EngineInterface, entry: CompactionRecord): Promise<void> {
  const value = await update($, stats, s => ({ ...s, compactions: [...s.compactions, entry].slice(-100) }))
  await persist($, value)
}

export const register: Register = (on, options) => {
  const opts = options as unknown as Options
  const cache = newReaderCache()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    setSessionCwd(await $.session.cwd())
    await $.tool.register({ name: 'session_recall', description: RECALL_DESCRIPTION, inputSchema: RECALL_SCHEMA })
    await $.command.register({ name: 'compactor-stats', description: 'Show what compaction did in this session' })
    // A resumed session picks its stats back up.
    if ((await read($, stats)).compactions.length === 0) {
      const all = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, CompactorStats>
      const saved = all[await $.session.id()]
      if (saved) await update($, stats, () => saved)
    }
    return started
  })

  on('settings.read', async ($, e, next) => {
    const settings = await next(e)
    if (e.source || !(opts.autoCompactWindow > 0)) return settings
    return { ...settings, autoCompactWindow: opts.autoCompactWindow }
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    // Subagents and forks keep the engine's own compaction.
    if (e.agentId !== undefined) return next(e)
    const args = parseCompactArgs(e.instructions)
    const method = args.method ?? opts.method
    // Lossless costs nothing, so it is computed when asked, never ahead.
    if (e.trigger === 'precompute') return method === 'llm' ? next(e) : { skip: 'computed on demand' }

    const startedAt = await $.clock.now()
    const usage = await $.session.usage()
    const tokensBefore = usage.context.tokens
    const window = usage.context.window > 0 ? usage.context.window : undefined

    if (method === 'llm') {
      const result = await next({ ...e, instructions: args.focus || undefined })
      if (result.skip === undefined) {
        await record($, {
          at: startedAt,
          trigger: e.trigger,
          method: 'llm',
          ms: (await $.clock.now()) - startedAt,
          tokensBefore: result.tokensBefore ?? tokensBefore,
          tokensAfter: result.tokensAfter,
        })
      }
      return result
    }

    try {
      const transcript = await readTranscript($, cache)
      if (!transcript) throw new Error('transcript file not found')
      const result = compactLossless(transcript, e.messages, {
        keepUserTurns: args.keepUserTurns,
        smartKeepTail: opts.smartKeepTail,
        summaryBudgetTokens: opts.summaryBudgetTokens,
        window,
        tokensBefore,
        cwd: await $.session.cwd(),
      })
      const kept = result.messages.length - 1
      await record($, {
        at: startedAt,
        trigger: e.trigger,
        method: 'lossless',
        ms: (await $.clock.now()) - startedAt,
        tokensBefore,
        tokensAfter: result.tokensAfterEst,
        summaryTokens: result.summaryTokens,
        summarizedMessages: result.cut.index,
        keptMessages: kept,
        keptUserTurns: result.cut.keptUserTurns,
        sections: result.sections,
        note: result.isTailAnchored ? undefined : 'tail not found in transcript; summary covers it too',
      })
      if (opts.notify && e.trigger !== 'manual') {
        $.ui.toast(`Compacted losslessly: ${fmt(tokensBefore)} → ~${fmt(result.tokensAfterEst)} tokens, kept ${result.cut.keptUserTurns} turn(s)`)
      }
      return { messages: result.messages, tokensBefore }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      $.ui.toast(`Lossless compaction failed (${reason}); using Claude Code's own`)
      const result = await next(e)
      if (result.skip === undefined) {
        await record($, {
          at: startedAt,
          trigger: e.trigger,
          method: 'fallback',
          ms: (await $.clock.now()) - startedAt,
          tokensBefore: result.tokensBefore ?? tokensBefore,
          tokensAfter: result.tokensAfter,
          note: reason,
        })
      }
      return result
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: RECALL }, async ($, e) => {
    const input = e as unknown as { query?: string; expand?: number[]; mode?: string; scope?: string; page?: number }
    const transcript = await readTranscript($, cache)
    if (!transcript) return { result: 'The session transcript file was not found.' }
    const scope = input.scope === 'all' ? 'all' : 'lineage'
    const { text } = vccRecall(recallBlocks(transcript, scope), input)
    const value = await update($, stats, s => ({ ...s, recallQueries: s.recallQueries + 1 }))
    await persist($, value)
    return { result: text }
  }).catch(() => ({ deny: 'session_recall failed; try a simpler query.' }))

  on('command.run', { command: 'compactor-stats' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Compaction' })
    return { text: 'Opened the compaction stats pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { compactions, recallQueries } = await read($, stats)
    const { context } = await $.session.usage()
    const saved = compactions.reduce(
      (n, c) => n + (c.tokensBefore !== undefined && c.tokensAfter !== undefined ? c.tokensBefore - c.tokensAfter : 0),
      0,
    )
    const room = Math.max(3, (e.props.scroll?.bodyRows ?? 20) - 7)
    const width = Math.max(20, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        <Text>
          Method {opts.method} · context {fmt(context.tokens)}/{fmt(context.window)}
          {context.percent !== undefined ? ` (${Math.round(context.percent)}%)` : ''}
        </Text>
        <Text>
          {compactions.length} compaction(s) · ~{fmt(saved)} tokens saved · {recallQueries} recall quer
          {recallQueries === 1 ? 'y' : 'ies'}
        </Text>
        <Text dimColor>{'─'.repeat(Math.min(width, 60))}</Text>
        {compactions.length === 0 && <Text dimColor>No compactions yet in this session.</Text>}
        {compactions
          .slice(-room)
          .reverse()
          .map(c => (
            <Box flexDirection="column">
              <Text>
                {new Date(c.at).toLocaleTimeString()} {c.trigger} · {c.method} · {fmt(c.tokensBefore)} → {fmt(c.tokensAfter)} ·{' '}
                {c.ms}ms
              </Text>
              {c.method === 'lossless' && (
                <Text dimColor>
                  {'  '}summary {fmt(c.summaryTokens)} · summarized {c.summarizedMessages} msgs · kept {c.keptMessages} msgs ({c.keptUserTurns}{' '}
                  turns)
                </Text>
              )}
              {c.sections && c.sections.length > 0 && <Text dimColor>{'  '}{c.sections.join(', ')}</Text>}
              {c.note && <Text color="yellow">{'  '}{c.note}</Text>}
            </Box>
          ))}
        <Box>
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
