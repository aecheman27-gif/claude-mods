import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import { parseShell, pythonHits } from './detect'

const DAQ_DO = `import nidaqmx
with nidaqmx.Task() as task:
    task.do_channels.add_do_chan("Dev1/port0/line0")
    task.write(True)
`
const MODBUS = `from pymodbus.client import ModbusTcpClient
c = ModbusTcpClient("10.0.0.5")
c.write_coil(1, True)
`

type World = { asked: string[]; ran: string[]; toasts: string[]; store: Map<string, unknown> }
type Answer = 'Cancel' | 'Run it' | 'close' | 'throw'

function world(on: On, files: Record<string, string>, answer: Answer = 'Cancel', cwdFails = false, storeFails = false): World {
  const w: World = { asked: [], ran: [], toasts: [], store: new Map() }
  on('store.get', async ($, e) => {
    if (storeFails) throw new Error('store unavailable')
    return { value: w.store.get(e.key) } as never
  })
  on('store.set', async ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('session.cwd', async () => {
    if (cwdFails) throw new Error('boom')
    return { value: 'C:/work' } as never
  })
  on('fs.read', async ($, e) => {
    const text = files[e.path.replace(/\\/g, '/')]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const q = e.questions[0]
    w.asked.push(q.question)
    if (answer === 'close') return { deny: 'The user dismissed the question.' }
    if (answer === 'throw') throw new Error('no one to ask')
    return { result: { questions: e.questions, answers: { [q.question]: answer } } } as never
  })
  on('tool.call', async ($, e) => {
    w.ran.push(e.tool)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ source: 'startup', cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never) as Promise<{ deny?: string }>
const pwsh = ($: Engine, command: string) => $.tool.call({ tool: 'PowerShell', command } as never) as Promise<{ deny?: string }>

describe('required cases', () => {
  test('plain Python run passes without asking', async ($, on) => {
    const w = world(on, { 'C:/work/hello.py': 'print("hello")\n' })
    await start($)
    const r = await bash($, 'python hello.py')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Bash'])
  })

  test('DAQmx DO write + Cancel is denied', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'Cancel')
    await start($)
    const r = await bash($, 'python blink.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (blink.py)'])
    expect(r.deny).toContain('did not approve')
    expect(w.ran).toEqual([])
  })

  test('DAQmx DO write + Run it proceeds', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'Run it')
    await start($)
    const r = await bash($, 'python blink.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (blink.py)'])
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash'])
  })

  test('closed question is denied', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'close')
    await start($)
    const r = await bash($, 'python blink.py')
    expect(r.deny).toBeDefined()
    expect(w.ran).toEqual([])
  })

  test('grep mentioning write_coil is not flagged', async ($, on) => {
    const w = world(on, {})
    await start($)
    const r = await bash($, 'grep -rn "client.write_coil(1, True)" src/ && echo "c.write_coil(1, True)"')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Bash'])
  })
})

describe('more cases', () => {
  test('nobody can answer (claude -p) is denied', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'throw')
    await start($)
    const r = await bash($, 'python blink.py')
    expect(r.deny).toBeDefined()
    expect(w.ran).toEqual([])
  })

  test('an error inside the guard denies', async ($, on) => {
    const w = world(on, {}, 'Run it', true)
    await start($)
    const r = await bash($, 'python blink.py')
    expect(r.deny).toContain('check failed')
    expect(w.ran).toEqual([])
  })

  test('typed Other text does not count as Run it', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO })
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: 'sure go ahead' } } }) as never)
    await start($)
    const r = await bash($, 'python blink.py')
    expect(r.deny).toBeDefined()
    expect(w.ran).toEqual([])
  })

  test('python -c with a pymodbus write is flagged', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, `python -c "from pymodbus.client import ModbusTcpClient; ModbusTcpClient('x').write_register(3, 7)"`)
    expect(w.asked).toEqual(['Hardware write: pymodbus write_register (python -c)'])
  })

  test('PowerShell here-string piped to python is flagged', async ($, on) => {
    const w = world(on, {})
    await start($)
    await pwsh($, `@'\n${MODBUS}'@ | python -`)
    expect(w.asked[0]).toContain('pymodbus write_coil')
  })

  test('bash heredoc to a file then run is flagged', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, `cat > t.py <<'EOF'\n${DAQ_DO}EOF\npython3 t.py`)
    expect(w.asked[0]).toContain('nidaqmx DO write')
  })

  test('mosquitto_pub to a Bambu printer topic is flagged', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, `mosquitto_pub -h 10.0.0.9 -t device/01S00A/request -m '{"print":{"command":"pause"}}'`)
    expect(w.asked[0]).toContain('device/01S00A/request')
  })

  test('Write of Python with write_coil only in a comment passes', async ($, on) => {
    const w = world(on, {})
    await start($)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/notes.py', content: 'from pymodbus.client import ModbusTcpClient\n# c.write_coil(1, True)\nprint("todo")\n' } as never)
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Write'])
  })

  test('Edit that adds an AO write to a nidaqmx file is flagged', async ($, on) => {
    const src = 'import nidaqmx\nt = nidaqmx.Task()\nt.ao_channels.add_ao_voltage_chan("Dev1/ao0")\n# TODO\n'
    const w = world(on, { 'C:/work/ao.py': src })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'C:/work/ao.py', old_string: '# TODO', new_string: 't.write(2.5)' } as never)
    expect(w.asked).toEqual(['Hardware write: nidaqmx AO write in ao.py'])
  })

  test('Edit elsewhere in a file that already writes is not flagged', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO + '\nprint("x")\n' })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'C:/work/blink.py', old_string: 'print("x")', new_string: 'print("y")' } as never)
    expect(w.asked).toEqual([])
  })

  test('reading DO without writing is not flagged', async ($, on) => {
    const w = world(on, { 'C:/work/r.py': 'import nidaqmx\nt = nidaqmx.Task()\nt.di_channels.add_di_chan("Dev1/port0")\nprint(t.read())\n' })
    await start($)
    await bash($, 'python r.py')
    expect(w.asked).toEqual([])
  })
})

// Each of these ran with no question before the fix; drive.py writes a DAQ DO line.
const SHELL_FORMS: [string, string][] = [
  ['$( ) substitution', 'x=$(python drive.py)'],
  ['subshell', '(python drive.py)'],
  ['backticks', 'echo `python drive.py`'],
  ['timeout', 'timeout 30 python drive.py'],
  ['nice', 'nice -n 5 python drive.py'],
  ['xargs', 'ls | xargs python drive.py'],
  ['for/do', 'for i in 1 2; do python drive.py; done'],
  ['if/then', 'if true; then python drive.py; fi'],
  ['else', 'if false; then :; else python drive.py; fi'],
  ['bash -c', 'bash -c "python drive.py"'],
  ['sh -c', "sh -c 'python drive.py'"],
  ['cmd /c', 'cmd /c "python drive.py"'],
  ['pwsh -Command', 'pwsh -NoProfile -Command "python drive.py"'],
  ['powershell -Command', 'powershell -Command "python drive.py"'],
]

describe('bypass 1: shell forms', () => {
  for (const [name, command] of SHELL_FORMS) {
    test(`${name} is flagged`, async ($, on) => {
      const w = world(on, { 'C:/work/drive.py': DAQ_DO })
      await start($)
      const r = await bash($, command)
      expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
      expect(r.deny).toBeDefined()
      expect(w.ran).toEqual([])
    })
  }
})

describe('bypass 2: Windows paths in Bash double quotes', () => {
  test('quoted Windows script path is flagged', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await bash($, String.raw`python "C:\work\drive.py"`)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })

  test('quoted Windows python.exe is recognised', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await bash($, String.raw`"C:\Python312\python.exe" drive.py`)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })
})

describe('bypass 3: scripts that cannot be read ask', () => {
  test('cd earlier in the command resolves the script', async ($, on) => {
    const w = world(on, { 'C:/work/tools/drive.py': DAQ_DO })
    await start($)
    await bash($, 'cd tools && python drive.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })

  test('missing script asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    const r = await bash($, 'python missing.py')
    expect(w.asked).toEqual(['Hardware write check: could not inspect missing.py'])
    expect(r.deny).toBeDefined()
    expect(w.ran).toEqual([])
  })

  test('python -m with an unknown module asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, 'python -m pkg.module')
    expect(w.asked).toEqual(['Hardware write check: could not inspect python -m pkg.module'])
  })

  test('python -m with a local module is inspected', async ($, on) => {
    const w = world(on, { 'C:/work/tools/drive.py': DAQ_DO })
    await start($)
    await bash($, 'python -m tools.drive')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (python -m tools.drive)'])
  })

  test('downloaded code on stdin asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, 'curl -s http://10.0.0.2/drive.py | python -')
    expect(w.asked).toEqual(['Hardware write check: could not inspect python stdin'])
  })

  test('stdin redirected from a script is inspected', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await bash($, 'python - < drive.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })

  test('script names from xargs ask', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, 'echo drive.py | xargs python')
    expect(w.asked).toEqual(['Hardware write check: could not inspect python args from xargs'])
  })

  test('heredoc the shell expands asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, 'python - <<EOF\n$(cat drive.py)\nEOF')
    expect(w.asked).toEqual(['Hardware write check: could not inspect python stdin'])
  })
})

describe('unrelated commands do not ask', () => {
  for (const command of ['git status', 'ls -la', 'python --version', 'pip install requests', 'python -m pip install requests', 'python -m pytest -q tests', 'pytest -q']) {
    test(`${command} passes without asking`, async ($, on) => {
      const w = world(on, {})
      await start($)
      const r = await bash($, command)
      expect(r.deny).toBeUndefined()
      expect(w.asked).toEqual([])
      expect(w.ran).toEqual(['Bash'])
    })
  }
})

describe('detect', () => {
  test('pyserial write', async () => {
    expect(pythonHits('import serial\ns = serial.Serial("COM3", 115200)\ns.write(b"M104 S200\\n")\n')).toEqual(['pyserial write'])
  })
  test('string mention is not code', async () => {
    expect(pythonHits('import nidaqmx\nprint("task.do_channels.add_do_chan then task.write(True)")\n')).toEqual([])
  })
  test('shell parse keeps quoted grep args as one word', async () => {
    const { segments } = parseShell('grep "write_coil(" a.py | wc -l', false)
    expect(segments[0].map(s => s.words[0])).toEqual(['grep', 'wc'])
  })
})

describe('modes', () => {
  const guard = ($: Engine, args: string) =>
    $.command.run({ command: 'hw-guard', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as CommandRunInput) as Promise<{ text?: string }>

  test('notify runs a hardware write without asking and toasts it', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO })
    await start($)
    const r0 = await guard($, 'notify')
    expect(r0.text).toContain('without asking')
    expect(w.store.get('mode')).toBe('notify')
    const r = await bash($, 'python blink.py')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
    expect(w.toasts).toEqual(['hw-write-guard: running nidaqmx DO write (blink.py)'])
    expect(w.ran).toEqual(['Bash'])
  })

  test('off skips the check entirely', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO })
    await start($)
    await guard($, 'off')
    const r = await bash($, 'python blink.py')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.ran).toEqual(['Bash'])
  })

  test('ask turns the question back on', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'Cancel')
    await start($)
    await guard($, 'notify')
    await guard($, 'ask')
    const r = await bash($, 'python blink.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (blink.py)'])
    expect(r.deny).toContain('did not approve')
  })

  test('an unknown word keeps the mode and shows usage', async ($, on) => {
    const w = world(on, {})
    await start($)
    const r = await guard($, 'quiet')
    expect(r.text).toContain('Usage')
    expect(w.store.has('mode')).toBe(false)
    const status = await guard($, '')
    expect(status.text).toContain('asks before each hardware write')
  })

  test('a mode change that the user did not type is refused', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'Cancel')
    await start($)
    for (const kind of ['sdk', 'peer', 'scheduled-trigger', 'auto-continuation', 'unclassified']) {
      const r = (await $.command.run({ command: 'hw-guard', args: 'off', origin: { kind }, presentation: { isFullscreen: false, columns: 100 } } as unknown as CommandRunInput)) as { text?: string }
      expect(r.text).toContain('only the user')
    }
    expect(w.store.has('mode')).toBe(false)
    const r = await bash($, 'python blink.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (blink.py)'])
    expect(r.deny).toContain('did not approve')
  })

  test('a store that cannot be read means ask', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO }, 'Cancel', false, true)
    await start($)
    const r = await bash($, 'python blink.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (blink.py)'])
    expect(r.deny).toContain('did not approve')
  })
})
