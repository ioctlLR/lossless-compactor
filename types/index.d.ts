export type CompactionRecord = {
  at: number
  trigger: string
  method: 'lossless' | 'llm' | 'fallback'
  ms: number
  tokensBefore?: number
  tokensAfter?: number
  summaryTokens?: number
  summarizedMessages?: number
  keptMessages?: number
  keptUserTurns?: number
  sections?: string[]
  note?: string
}

export type CompactorStats = {
  compactions: CompactionRecord[]
  recallQueries: number
}

declare module 'claude-code' {
  interface PluginState {
    'lossless-compactor': { stats: CompactorStats }
  }
}
