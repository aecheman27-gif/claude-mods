// my-claude-mods: holding a migration must not run the project's own code.
import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

declare const setTimeout: (fn: (...args: never[]) => void, ms: number) => unknown // the test runner's; the API types declare no timers

test('a held manage.py migrate runs no project code, and Cancel refuses it', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, {})
  const runs: string[][] = []
  let opened = false
  on('session.cwd', async () => ({ value: '/work/app' }) as never)
  on('process.run', async ($, e) => {
    runs.push([...(e.argv as string[])])
    if ((e.argv as string[])[0] === 'sleep') await new Promise(r => setTimeout(r, 5)) // the hold's poll: let the test act
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => {
    opened = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => ({ value: undefined }) as never)
  on('tool.call', async () => ({ result: {}, text: 'ran' }) as never)

  const call = $.tool.call({ tool: 'Bash', command: 'python3 manage.py migrate' } as never)
  for (let i = 0; i < 200 && !opened; i++) await new Promise(r => setTimeout(r, 5))
  expect(opened).toBe(true)

  const pane: RenderPropsOf['Pane'] = { title: 'Blast Radius', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never
  const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'Pane', requestId: 'blast-radius', props: pane } as never)
  expect((await ui.findAll({}))[0]?.text ?? '').toContain('not listed')
  await ui.press({ key: 'cancel' })
  const r = await call

  expect(JSON.stringify(r)).toContain('Blast Radius')
  const project = runs.filter(a => a[0] !== 'sleep')
  expect(project).toEqual([])
})
