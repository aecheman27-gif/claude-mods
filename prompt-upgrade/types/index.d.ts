/** One question the model asked about the prompt, with the answers to pick from. */
export type Question = {
  /** 'q1', 'q2', ...: the Select's key */
  id: string
  text: string
  options: string[]
}

/** The pane's flow, from the prompt as typed to the upgraded one. */
export type Upgrade = {
  /** asking: the questions are being written; answering: the person picks; writing: the rewrite runs */
  phase: 'asking' | 'answering' | 'writing' | 'ready' | 'error'
  /** the prompt as the person typed it */
  original: string
  questions: Question[]
  /** question id -> the option picked; absent or '' when skipped */
  answers: Record<string, string>
  /** what the person typed under "Anything else?" */
  extra: string
  /** the upgraded prompt, once written */
  upgraded: string
  /** why the last model call gave nothing */
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      /** null while the pane is closed */
      view: Upgrade | null
    }
  }
}
