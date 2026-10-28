import { normalizeRow } from '../hooks/lib/transcript'
import { selectLessons } from '../hooks/lib/summarize'
import { expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

const RECALL = 'mcp__lossless-compactor__session_recall'

const rows = [
  { type: 'user', uuid: 'u1', parentUuid: null, origin: { kind: 'human' }, message: { role: 'user', content: 'Use redis for the cache, never memcached.' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the cache layer.' }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/proj/src/cache.ts', old_string: 'memcached', new_string: 'redis' } }] } },
  { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'Switched the cache to redis.' }] } },
  { type: 'user', uuid: 'm1', parentUuid: 'a3', isMeta: true, message: { role: 'user', content: '<system-reminder>injected</system-reminder>' } },
  { type: 'user', uuid: 'u3', parentUuid: 'm1', origin: { kind: 'human' }, message: { role: 'user', content: 'Now add tests for the cache.' } },
  { type: 'assistant', uuid: 'a4', parentUuid: 'u3', message: { role: 'assistant', content: [{ type: 'text', text: 'Adding tests.' }] } },
]
const JSONL = rows.map(r => JSON.stringify(r)).join('\n') + '\n'

const messages: SessionMessage[] = [
  { role: 'user', text: 'Use redis for the cache, never memcached.', toolUses: [], handle: 'h1' },
  { role: 'assistant', text: 'Looking at the cache layer.', toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: '/proj/src/cache.ts' }, text: 'ok' }], handle: 'h2' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }], handle: 'h3' },
  { role: 'assistant', text: 'Switched the cache to redis.', toolUses: [], handle: 'h4' },
  { role: 'user', text: 'Now add tests for the cache.', toolUses: [], handle: 'h5' },
  { role: 'assistant', text: 'Adding tests.', toolUses: [], handle: 'h6' },
]

/** Stands in for the engine and the host beneath the plugin. */
function host(on: any, jsonl = JSONL) {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 50_000, window: 100_000, percent: 50 }, rateLimits: [] } }))
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__lossless-compactor__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'compactor-stats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me/.claude/projects/p/sid.jsonl\n', stderr: '' } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: jsonl.length, mtimeMs: 0, isLink: false } }))
  on('process.spawn', async function* ($: unknown, e: unknown, next: any) {
    yield { stream: 'stdout', text: jsonl }
    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', () => ({ value: undefined }))
  // The engine's own compaction, for the llm method and the fallback.
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }))
}

test('lossless compaction rebuilds the summary from the transcript and keeps the tail', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)

  const result = await $.session.compact({ trigger: 'manual', instructions: 'keep:1', messages } as any)
  if (result.skip !== undefined) throw new Error(`skipped: ${result.skip}`)

  const [summary, ...tail] = result.messages
  expect(summary!.text).toContain('<lossless-compaction-summary>')
  expect(summary!.text).toContain('Use redis for the cache, never memcached.')
  expect(summary!.text).toContain('src/cache.ts')
  // The kept turn is not summarized again, and the injected row never shows.
  expect(summary!.text).not.toContain('Now add tests for the cache.')
  expect(summary!.text).not.toContain('injected')
  expect(tail.map(m => m.handle)).toEqual(['h5', 'h6'])
})

test('precompute is skipped and the llm method goes to the engine', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)

  const ahead = await $.session.compact({ trigger: 'precompute', messages } as any)
  expect(ahead.skip).toBe('computed on demand')

  const llm = await $.session.compact({ trigger: 'manual', instructions: 'method:llm', messages } as any)
  expect(llm.messages?.[0]?.text).toBe('engine summary')
})

test('session_recall finds what compaction removed', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)

  const found = await $.tool.call({ tool: RECALL, query: 'memcached' } as any)
  expect(String(found.result)).toContain('#1')
  expect(String(found.result)).toContain('never memcached')

  const expanded = await $.tool.call({ tool: RECALL, expand: [3] } as any)
  expect(String(expanded.result)).toContain('cache.ts')
})

test('the stats pane shows each compaction, on every surface', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)
  await $.session.compact({ trigger: 'manual', messages } as any)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'lossless-compactor',
      component: 'Pane',
      requestId: 'compactor-stats',
      surface,
      props: { title: 'Compaction', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    } as any)
    expect(await ui.find({ type: 'Text', text: /1 compaction/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /manual · lossless/ })).toBeDefined()
    await ui.unmount()
  }
})

// As Claude Code writes them: parallel results hang off their own tool_use row,
// and a compaction that keeps a tail writes those rows again under new uuids.
const at = (n: number) => `2026-10-28T10:00:${String(n).padStart(2, '0')}.000Z`
const before = [
  { type: 'user', uuid: 'p1', parentUuid: null, timestamp: at(1), origin: { kind: 'human' }, message: { role: 'user', content: '<system-reminder>harness note</system-reminder>\nCheck both configs.' } },
  { type: 'assistant', uuid: 'c1', parentUuid: 'p1', timestamp: at(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/proj/a.json' } }] } },
  { type: 'assistant', uuid: 'c2', parentUuid: 'c1', timestamp: at(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/proj/b.json' } }] } },
  { type: 'user', uuid: 'x1', parentUuid: 'c1', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'alphaport 8080' }] } },
  { type: 'user', uuid: 'x2', parentUuid: 'c2', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'betaport 9090' }] } },
  { type: 'assistant', uuid: 'c3', parentUuid: 'x2', timestamp: at(6), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Kept work: zebra migration finished.' }] } },
]
const after = [
  { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'c3', timestamp: at(7) },
  { type: 'user', uuid: 's1', parentUuid: 'b1', timestamp: at(7), message: { role: 'user', content: '<lossless-compaction-summary>old summary</lossless-compaction-summary>' } },
  { ...before[5], uuid: 'k3', parentUuid: 's1' },
  { type: 'user', uuid: 'p2', parentUuid: 'k3', timestamp: at(8), origin: { kind: 'human' }, message: { role: 'user', content: 'Next step.' } },
]
const COMPACTED = [...before, ...after].map(r => JSON.stringify(r)).join('\n') + '\n'

test('recall reaches parallel results and skips the copies a compaction wrote', async ($, on) => {
  host(on, COMPACTED)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as any)

  const parallel = await $.tool.call({ tool: RECALL, query: 'alphaport' } as any)
  expect(String(parallel.result)).toContain('#4')

  const kept = String((await $.tool.call({ tool: RECALL, query: 'zebra' } as any)).result)
  expect(kept).toContain('#6')
  expect(kept).not.toContain('#9')

  const result = await $.session.compact({ trigger: 'manual', instructions: 'keep:0', messages } as any)
  if (result.skip !== undefined) throw new Error(`skipped: ${result.skip}`)
  const summary = result.messages[0]!.text
  expect(summary).toContain('Check both configs.')
  expect(summary).not.toContain('harness note')
  expect(summary).toContain('#6')
  expect(summary).not.toContain('#9')
})

test('lessons keep findings, not headings or plan bullets', () => {
  const blocks = normalizeRow(
    {
      line: 1, uuid: 'a', role: 'assistant', isSidechain: false, isHidden: false, isHuman: false, isToolResult: false, copyKey: 'a',
      content: [{ type: 'text', text: '## Caveat\n`$.session.compact()` rejects while a turn is running.\n- **Commands**: `compact-then` becomes a normal command instead of an autocomplete workaround.' }],
    },
    new Map(),
  )
  expect(selectLessons(blocks, 2000)).toEqual(['`$.session.compact()` rejects while a turn is running.'])
})
