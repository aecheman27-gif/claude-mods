export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
export type PlanSubstep = { title: string; status: StepStatus }
// doneAt: when the step was finished, so a checkpoint can tell how long it took
export type PlanStep = { title: string; status: StepStatus; substeps: PlanSubstep[]; doneAt?: number }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
// one subagent shown as a state strip under a bar; depth 1 sits under its parent agent
export type AgentRun = {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'error'
  tool: string
  startedAt: number
  endedAt: number | null
  depth: number
  // the model it runs on and its effort, as the engine resolved them
  model?: string
  effort?: string
  // Modified for my-claude-mods: the agent's own task count, from its todo list (TodoWrite, TaskCreate/TaskUpdate)
  // or its progress_step calls; unset until it reports. stepNote is the item in progress
  stepsDone?: number
  stepsTotal?: number
  stepNote?: string
}
export type Plan = {
  id: string
  title: string
  kind: 'plan' | 'todo'
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  // when the plan was finished; the pill then shows the time it took
  endedAt?: number | null
  agents?: AgentRun[]
  // when the current batch of agents all finished; their strips fold a few seconds later
  agentsDoneAt?: number | null
  // the person folded the bar's agent strips away (its ▾ button, /progress-agents); the bar keeps one line
  isFolded?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'plan-progress': {
      // Modified for my-claude-mods: each plan's agents may carry stepsDone/stepsTotal/stepNote (see AgentRun)
      plans: Plan[]
      isOpen: boolean
      // bumped every second while agents run, so elapsed times and folding redraw
      tick: number
    }
  }
}
