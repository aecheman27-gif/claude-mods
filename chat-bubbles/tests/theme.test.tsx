// Engine tests: the plugin loaded by the engine's own host, its hooks drawn on
// the surfaces a person uses.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ENGINE_ROW, id, store } from './helpers'

const SURFACES = ['terminal', 'desktop'] as const

// The first engine test pays for the host's cold start; on a busy machine that
// can pass the default 5 s, so engine tests get room.
const ENGINE = { timeoutMs: 20_000 }

/** `/theme <args>` as the person would type it at an 80-column terminal. */
const theme = ($: Engine, args: string) =>
  $.command.run({
    command: 'bubbles',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

describe('/theme', () => {
  test('applies a theme by name and reports it', ENGINE, async $ => {
    const done = await theme($, 'dracula')
    expect(done.text).toContain('Dracula')
  })

  test('lists every collection', ENGINE, async $ => {
    const done = await theme($, 'list')
    expect(done.text).toContain('Hockey')
    expect(done.text).toContain('Dev Classics')
  })

  test('suggests close names for a typo', ENGINE, async $ => {
    const done = await theme($, 'drakula')
    expect(done.text).toContain('No theme matches')
  })

  test('rejects a bad background and accepts a hex', ENGINE, async $ => {
    expect((await theme($, 'bg nope')).text).toContain("isn't a hex color")
    expect((await theme($, 'bg #1a1a2e')).text).toContain('#1a1a2e')
    expect((await theme($, 'bg auto')).text).toContain('Background back')
  })
})

describe('drawing', () => {
  test('a prompt is redrawn as a right-hand bubble in the terminal', ENGINE, async $ => {
    await theme($, 'matrix')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'terminal',
      component: 'UserMessage',
      props: { text: 'make it pop', origin: { kind: 'composer' }, isExpanded: true },
    })
    expect(await ui.find({ type: 'Text', text: 'make it pop' })).toBeTruthy()
    expect(await ui.find({ type: 'Box', key: 'you-bubble' })).toBeTruthy()
  })

  // The engine's own row is a leaf node, and the engine refuses a tree that
  // sets `width` or `minWidth` on any Box above it (then it draws its own row,
  // unchanged). A stand-in Text would not catch that, so these use the real
  // kind of node.
  for (const [surface, isExpanded] of [['desktop', true], ['terminal', false]] as const) {
    test(`frame mode wraps the engine's own row without a refused tree on ${surface}`, ENGINE, async ($, on) => {
      on('ui.render', { component: 'UserMessage' }, () => ({ type: 'engine', ref: 0 }) as never)
      await theme($, 'matrix')
      await theme($, 'prompt frame')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'UserMessage',
        props: { text: 'look at this', origin: { kind: 'sdk' }, isExpanded },
      })
      expect(await ui.find({ type: 'Box', key: 'you-bubble' })).toBeTruthy()
    })
  }

  for (const surface of SURFACES) {
    test(`bubble mode draws a text bubble on the right on ${surface}`, ENGINE, async ($, on) => {
      on('ui.render', { component: 'UserMessage' }, ENGINE_ROW)
      const row = id(surface === 'terminal' ? 30 : 31)
      await store($, row, 'hola mundo')
      await theme($, 'matrix')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'UserMessage',
        requestId: row,
        props: { text: 'hola mundo', origin: { kind: 'sdk' }, isExpanded: true },
      })
      expect(await ui.find({ type: 'Text', text: 'hola mundo' })).toBeTruthy()
      expect(await ui.find({ type: 'Box', key: 'you-bubble' })).toBeTruthy()
    })
  }

  test('native mode leaves the engine row alone', ENGINE, async ($, on) => {
    on('ui.render', { component: 'UserMessage' }, () => ({ type: 'engine', ref: 0 }) as never)
    await theme($, 'matrix')
    await theme($, 'prompt native')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text: 'hola', origin: { kind: 'sdk' }, isExpanded: true },
    })
    expect(await ui.find({ type: 'Box', key: 'you-bubble' })).toBe(undefined)
  })

  test('/bubbles prompt rejects an unknown style and reports the current one', ENGINE, async $ => {
    const bad = await theme($, 'prompt nope')
    expect(bad.text).toContain('Use `/bubbles prompt')
    expect((await theme($, 'prompt frame')).text).toContain('frame')
  })

  test('on desktop tool rows are left to the engine: no empty stripe', ENGINE, async ($, on) => {
    on('ui.render', { component: 'ToolGroup' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine group</Text>
    })
    await theme($, 'matrix')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'desktop',
      component: 'ToolGroup',
      props: { calls: [], isActive: true, isExpanded: false },
    })
    expect(await ui.find({ type: 'Text', text: '▍' })).toBe(undefined)
  })

  for (const surface of SURFACES) {

    test(`a reply is painted in theme colors on ${surface}`, ENGINE, async $ => {
      await theme($, 'nord')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'AssistantMessage',
        props: { text: '# Plan\n- one **bold** step\n- `code` here', isFirstOfReply: true },
      })
      expect(await ui.find({ type: 'Text', text: '✦ Claude' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: 'bold' })).toBeTruthy()
    })

    test(`the footer chip opens the studio on ${surface}`, ENGINE, async ($, on) => {
      const opened: { id: string; columns?: number; focus?: true }[] = []
      // Stand in for the engine's pane host and record what the click asked for.
      on('ui.open', (_$, e) => {
        opened.push({ id: e.id, columns: e.columns, focus: e.focus })
        return { value: { isPlaced: true } }
      })
      // Stand in for the engine's own mode labels beneath the plugin.
      on('ui.render', { component: 'SessionMode' }, ENGINE_ROW)
      await theme($, 'dracula')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'SessionMode',
        props: { modes: ['accept edits on'] },
      })
      const chip = await ui.find({ type: 'Button', key: 'open-studio' })
      expect(chip?.props.label).toBe('🎨 Dracula')
      await ui.press({ key: 'open-studio' })
      expect(opened).toEqual([{ id: 'chat-bubbles', columns: 64, focus: true }])
    })

    test(`the footer keeps the row beneath on ${surface}`, ENGINE, async ($, on) => {
      // Stand in for another mod's button (plan-progress) drawn beneath.
      on('ui.render', { component: 'SessionMode' }, ($, e) => {
        const { Button } = $.ui.resolve(e)
        return <Button key="below-button" label="Progress" onPress={() => {}} />
      })
      await theme($, 'dracula')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'SessionMode',
        props: { modes: ['accept edits on'] },
      })
      expect(await ui.find({ type: 'Button', key: 'below-button' })).toBeTruthy()
      expect(await ui.find({ type: 'Button', key: 'open-studio' })).toBeTruthy()
    })

    test(`with no theme the engine draws its own on ${surface}`, ENGINE, async ($, on) => {
      // Stand in for the engine's own drawing beneath the plugin.
      on('ui.render', { component: 'UserMessage' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return <Text>engine row</Text>
      })
      await theme($, 'off')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'UserMessage',
        props: { text: 'plain', origin: { kind: 'sdk' }, isExpanded: true },
      })
      expect(await ui.find({ type: 'Box', key: 'you-bubble' })).toBe(undefined)
      expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeTruthy()
    })
  }
})

describe('chrome around the engine and other mods', () => {
  const props = (node: unknown) => (node as { props?: Record<string, unknown> }).props ?? {}

  for (const surface of SURFACES) {
    test(`another mod's pane gets the backdrop but no side padding, so its bodyColumns still fit, on ${surface}`, ENGINE, async ($, on) => {
      // Stand in for another mod's pane drawn beneath (plan-progress, sized to bodyColumns).
      on('ui.render', { component: 'Pane' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return <Text>other mod</Text>
      })
      await theme($, 'dracula')
      const ui = await $.ui.mount({
        plugin: 'chat-bubbles',
        surface,
        component: 'Pane',
        requestId: 'plan-progress',
        // the props this test reads; the pane's scroll and view do not matter here
        props: { title: 'Progress', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
      })
      const drawn = await ui.drawn()
      expect(props(drawn).backgroundColor).toBeTruthy()
      expect(props(drawn).paddingX ?? 0).toBe(0)
      expect(await ui.find({ type: 'Text', text: 'other mod' })).toBeTruthy()
    })
  }

  test('the studio pane keeps its side padding', ENGINE, async $ => {
    await theme($, 'dracula')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'chat-bubbles',
      props: { title: 'Chat Bubbles', isFocused: true, bodyColumns: 64, placement: 'dock' } as never,
    })
    expect(props(await ui.drawn()).paddingX).toBe(1)
  })

  test('an empty tool result another mod drew stays empty: no stripe line under the tool row', ENGINE, async ($, on) => {
    // Stand in for mission-control's /clean, which hides the result with an empty Box.
    on('ui.render', { component: 'ToolResult' }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    await theme($, 'dracula')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 't1', tool: 'Read', output: {}, isErrored: false },
    })
    expect(await ui.find({ type: 'Text', text: '▏' })).toBe(undefined)
  })

  test('a tool result with content keeps its stripe', ENGINE, async ($, on) => {
    on('ui.render', { component: 'ToolResult' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>Read 3 lines</Text>
    })
    await theme($, 'dracula')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 't1', tool: 'Read', output: {}, isErrored: false },
    })
    expect(await ui.find({ type: 'Text', text: '▏' })).toBeTruthy()
  })

  test("the spinner shimmers from the main turn's start to its own end: not for a prompt that starts no turn, not stopped by a subagent", ENGINE, async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    // Stand in for the engine beneath the plugin.
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    await theme($, 'dracula')
    const ui = await $.ui.mount({
      plugin: 'chat-bubbles',
      surface: 'desktop',
      component: 'Spinner',
      props: { word: 'Working', message: null, suffix: '…', mode: 'thinking' },
    })
    const spark = async () => (await ui.find({ type: 'Text', text: /^[✦✧✶✷✸✹] $/ }))?.text
    const done = (turnId: string, agentId?: string) =>
      $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) } as never)

    await $.prompt.submit({ text: '/config', origin: { kind: 'composer' }, wait: false })
    await clock.advance(1000)
    expect(await spark()).toBe('✦ ')
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(260)
    expect(await spark()).toBe('✧ ')
    await done('s1', 'subagent-1')
    await clock.advance(260)
    expect(await spark()).toBe('✶ ')
    await done('t1')
    await clock.advance(1000)
    expect(await spark()).toBe('✶ ')
  })
})
