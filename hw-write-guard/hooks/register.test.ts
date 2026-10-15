import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import { parseShell, pythonBlind, pythonHits } from './detect'

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

/** `unreadable`: files that exist but whose read rejects (over 4 MiB, no access). */
function world(on: On, files: Record<string, string>, answer: Answer = 'Cancel', cwdFails = false, storeFails = false, unreadable: string[] = []): World {
  const w: World = { asked: [], ran: [], toasts: [], store: new Map() }
  on('fs.exists', async ($, e) => {
    const p = e.path.replace(/\\/g, '/')
    return { value: files[p] !== undefined || unreadable.includes(p) } as never
  })
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
    const q = e.questions[0]!
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
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => ({ result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'sure go ahead' } } }) as never)
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
    expect(segments[0]!.map(s => s.words[0])).toEqual(['grep', 'wc'])
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

// ---------------------------------------------------------------- review fixes

const VALVES = `import nidaqmx
def open_valve():
    with nidaqmx.Task() as task:
        task.do_channels.add_do_chan("Dev1/port0/line0")
        task.write(True)
`
const SERIAL = 'import serial\ns = serial.Serial("COM3", 115200)\ns.write(b"G28\\n")\n'
const HELLO = 'print("hello")\n'
const notebook = (...cells: string[]) => JSON.stringify({ cells: cells.map(source => ({ cell_type: 'code', source })), nbformat: 4 })
const monitor = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'Monitor', description: 'watch', timeout_ms: 60000, ...input } as never) as Promise<{ deny?: string }>

describe('finding 1: Monitor commands are inspected', () => {
  test('a Monitor command running a hardware script asks', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    const r = await monitor($, { command: 'python drive.py' })
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
    expect(r.deny).toBeDefined()
    expect(w.ran).toEqual([])
  })
  test('a PowerShell-style Monitor loop is inspected too', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await monitor($, { command: 'while ($true) { python drive.py; Start-Sleep 5 }' })
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })
  test('tailing a log passes', async ($, on) => {
    const w = world(on, {})
    await start($)
    const r = await monitor($, { command: 'tail -f log.txt | grep --line-buffered ERROR' })
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Monitor'])
  })
  test('a WebSocket monitor passes', async ($, on) => {
    const w = world(on, {})
    await start($)
    await monitor($, { ws: { url: 'ws://10.0.0.9/events' } })
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Monitor'])
  })
})

describe('finding 2: local modules a script imports are read', () => {
  test('from lab.valves import ... reaches the DO write', async ($, on) => {
    const w = world(on, { 'C:/work/run.py': 'from lab.valves import open_valve\nopen_valve()\n', 'C:/work/lab/valves.py': VALVES })
    await start($)
    const r = await bash($, 'python run.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (valves.py from run.py)'])
    expect(r.deny).toBeDefined()
  })
  test('import x.y as z, and a package __init__', async ($, on) => {
    const w = world(on, { 'C:/work/run.py': 'import lab.valves as v\nv.open_valve()\n', 'C:/work/lab/__init__.py': '', 'C:/work/lab/valves.py': VALVES })
    await start($)
    await bash($, 'python run.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (valves.py from run.py)'])
  })
  test('relative imports inside a package are followed', async ($, on) => {
    const w = world(on, {
      'C:/work/run.py': 'from lab import rig\nrig.go()\n',
      'C:/work/lab/__init__.py': '',
      'C:/work/lab/rig.py': 'from .valves import open_valve\ndef go():\n    open_valve()\n',
      'C:/work/lab/valves.py': VALVES,
    })
    await start($)
    await bash($, 'python run.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (valves.py from run.py)'])
  })
  test("modules resolve from the script's own folder", async ($, on) => {
    const w = world(on, { 'C:/work/tools/run.py': 'import helper\nhelper.go()\n', 'C:/work/tools/helper.py': SERIAL })
    await start($)
    await bash($, 'python tools/run.py')
    expect(w.asked).toEqual(['Hardware write: pyserial write (helper.py from run.py)'])
  })
  test('a write split across the script and its module is seen', async ($, on) => {
    const w = world(on, {
      'C:/work/run.py': 'from rig import make_task\nt = make_task()\nt.write(True)\n',
      'C:/work/rig.py': 'import nidaqmx\ndef make_task():\n    t = nidaqmx.Task()\n    t.do_channels.add_do_chan("Dev1/port0/line0")\n    return t\n',
    })
    await start($)
    await bash($, 'python run.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (run.py with its imports)'])
  })
  test('python -c importing a local module', async ($, on) => {
    const w = world(on, { 'C:/work/lab/valves.py': VALVES })
    await start($)
    await bash($, 'python -c "from lab.valves import open_valve; open_valve()"')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (valves.py from python -c)'])
  })
  test('stdlib and installed packages are not asked about', async ($, on) => {
    const w = world(on, { 'C:/work/plot.py': 'import numpy as np, os\nfrom matplotlib import pyplot as plt\nimport json\nfrom lab import util\nprint(np.zeros(3))\n', 'C:/work/lab/util.py': HELLO })
    await start($)
    const r = await bash($, 'python plot.py')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
  })
  test('a local module that exists but cannot be read asks', async ($, on) => {
    const w = world(on, { 'C:/work/run.py': 'from lab.valves import open_valve\nopen_valve()\n' }, 'Cancel', false, false, ['C:/work/lab/valves.py'])
    await start($)
    await bash($, 'python run.py')
    expect(w.asked).toEqual(['Hardware write check: could not inspect valves.py (imported by run.py)'])
  })
  test('a module changed earlier in the command asks', async ($, on) => {
    const w = world(on, { 'C:/work/run.py': 'from lab.valves import open_valve\nopen_valve()\n', 'C:/work/lab/valves.py': HELLO })
    await start($)
    await bash($, "sed -i 's/# task.write/task.write/' lab/valves.py && python run.py")
    expect(w.asked).toEqual(['Hardware write check: could not inspect valves.py (changed earlier in the command)'])
  })
})

describe('finding 3: Start-Process arguments', () => {
  const FORMS = [
    'Start-Process python -ArgumentList "-u drive.py" -NoNewWindow -Wait',
    "Start-Process -FilePath python -ArgumentList '-u','drive.py' -Wait",
    "Start-Process python -ArgumentList '-u', 'drive.py'",
    'Start-Process python -ArgumentList:drive.py',
    'saps python drive.py',
    'start python -u drive.py',
  ]
  for (const command of FORMS) {
    test(`${command} is flagged`, async ($, on) => {
      const w = world(on, { 'C:/work/drive.py': DAQ_DO })
      await start($)
      const r = await pwsh($, command)
      expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
      expect(r.deny).toBeDefined()
    })
  }
  test('python -c inside an -ArgumentList string', async ($, on) => {
    const w = world(on, {})
    await start($)
    await pwsh($, `Start-Process python -ArgumentList '-c "from pymodbus.client import ModbusTcpClient; ModbusTcpClient(''x'').write_coil(1, True)"'`)
    expect(w.asked).toEqual(['Hardware write: pymodbus write_coil (python -c)'])
  })
  test('a bare python under Start-Process asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await pwsh($, 'Start-Process python -Wait')
    expect(w.asked).toEqual(['Hardware write check: could not inspect python under Start-Process'])
  })
  test('Start-Process of another program passes', async ($, on) => {
    const w = world(on, {})
    await start($)
    const r = await pwsh($, 'Start-Process notepad -ArgumentList readme.txt')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
  })
})

describe('finding 4: a file changed and run in the same command', () => {
  const CHANGED = 'Hardware write check: could not inspect drive.py (changed earlier in the command)'
  test('sed -i then run asks', async ($, on) => {
    const w = world(on, { 'C:/work/blink.py': DAQ_DO.replace('task.write', '# task.write') })
    await start($)
    await bash($, "sed -i 's/# task.write/task.write/' blink.py && python blink.py")
    expect(w.asked).toEqual(['Hardware write check: could not inspect blink.py (changed earlier in the command)'])
  })
  const BASH_FORMS = [
    'cp new.py drive.py; python drive.py',
    'mv new.py drive.py && python drive.py',
    "echo 'x' | tee drive.py && python drive.py",
    'curl -s -o drive.py http://10.0.0.2/d.py && python drive.py',
    'cp new/drive.py tools/ && python tools/drive.py',
    'echo x >> drive.py; python drive.py',
    '"/opt/my tools/gen" > drive.py && python drive.py',
    'bash -c "cp new.py drive.py" && python drive.py',
  ]
  for (const command of BASH_FORMS) {
    test(`${command} asks`, async ($, on) => {
      const w = world(on, { 'C:/work/drive.py': HELLO, 'C:/work/tools/drive.py': HELLO })
      await start($)
      const r = await bash($, command)
      expect(w.asked).toEqual([CHANGED])
      expect(r.deny).toBeDefined()
    })
  }
  const PS_FORMS = [
    "'x' | Out-File drive.py -Append; python drive.py",
    "Add-Content drive.py 'print(1)'; python drive.py",
    'Copy-Item new.py -Destination drive.py; python drive.py',
    'Invoke-WebRequest http://10.0.0.2/d.py -OutFile drive.py; python drive.py',
  ]
  for (const command of PS_FORMS) {
    test(`${command} asks`, async ($, on) => {
      const w = world(on, { 'C:/work/drive.py': HELLO })
      await start($)
      await pwsh($, command)
      expect(w.asked).toEqual([CHANGED])
    })
  }
  test('printf of literal hardware code then run is inspected', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': HELLO })
    await start($)
    await bash($, String.raw`printf 'import nidaqmx\nt = nidaqmx.Task()\nt.do_channels.add_do_chan("x")\nt.write(True)\n' > drive.py && python drive.py`)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })
  test('a here-string piped to Set-Content then run is inspected', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': HELLO })
    await start($)
    await pwsh($, `@'\n${DAQ_DO}'@ | Set-Content drive.py; python drive.py`)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })
  test('literal harmless code written over a hardware script passes', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    const r = await pwsh($, `@'\nimport time\nprint("hello")\n'@ | Set-Content -Path .\\drive.py -Encoding utf8; python drive.py`)
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
  })
  test('heredoc on stdin with an output redirect before it is inspected', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, `python - > out.txt <<'EOF'\n${DAQ_DO}EOF`)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (python stdin)'])
  })
  for (const command of ['cat drive.py && python drive.py', 'cp drive.py drive.py.bak && python drive.py', 'python drive.py > out.txt', 'git diff drive.py && python drive.py', 'sed -n 1,5p drive.py && python drive.py', 'ls -la drive.py; python drive.py']) {
    test(`${command} passes`, async ($, on) => {
      const w = world(on, { 'C:/work/drive.py': HELLO })
      await start($)
      const r = await bash($, command)
      expect(r.deny).toBeUndefined()
      expect(w.asked).toEqual([])
    })
  }
})

describe('finding 5: call forms', () => {
  test('python -c with a comma import and ; statements', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, `python -c "import time, serial; s=serial.Serial('COM3'); s.write(b'x')"`)
    expect(w.asked).toEqual(['Hardware write: pyserial write (python -c)'])
  })
  const HITS: [string, string, string[]][] = [
    ['serial alias', 'from serial import Serial as S\nS("COM3").write(b"x")\n', ['pyserial write']],
    ['serial import list', 'import time, serial; s = serial.Serial("COM3"); s.write(b"x")', ['pyserial write']],
    ['serial imported in a block', 'try:\n    import serial\nexcept ImportError:\n    serial = None\nport = serial.serial_for_url("COM3")\nport.write(b"x")\n', ['pyserial write']],
    ['writelines', 'import serial\ns = serial.Serial("COM3")\ns.writelines([b"a", b"b"])\n', ['pyserial write']],
    ['nidaqmx alias and a channel variable', 'import nidaqmx as nd\ntask = nd.Task()\nch = task.do_channels\nch.add_do_chan("Dev1/port0/line0")\ntask.write(True)\n', ['nidaqmx DO write']],
    ['pymodbus alias + mask_write_register', 'from pymodbus.client import ModbusSerialClient as M\nc = M(port="COM3")\nc.mask_write_register(1, 0xF0, 0x0F)\n', ['pymodbus mask_write_register']],
    ['readwrite_registers', 'from pymodbus.client import ModbusTcpClient\nc = ModbusTcpClient("x")\nc.readwrite_registers(read_address=1, write_address=2, values=[1])\n', ['pymodbus readwrite_registers']],
    ['execute(Write...Request)', 'from pymodbus.client import ModbusTcpClient\nfrom pymodbus.pdu.bit_message import WriteSingleCoilRequest\nc = ModbusTcpClient("x")\nc.execute(WriteSingleCoilRequest(1, True))\n', ['pymodbus WriteSingleCoilRequest']],
    ['paho publish.single', 'import paho.mqtt.publish as publish\npublish.single("device/01S00A/request", "{}", hostname="10.0.0.9")\n', ['MQTT publish to device/01S00A/request']],
    ['paho multiple under an alias', 'from paho.mqtt.publish import multiple as send\nsend([{"topic": "octoprint/cmd", "payload": "G28"}], hostname="x")\n', ['MQTT publish to octoprint/cmd']],
  ]
  for (const [name, src, hits] of HITS) {
    test(name, async () => {
      expect(pythonHits(src)).toEqual(hits)
    })
  }
  const LOOKALIKES: [string, string][] = [
    ['serial read', 'import serial\ns = serial.Serial("COM3")\nprint(s.read(10))\n'],
    ['modbus register read', 'from pymodbus.client import ModbusTcpClient\nc = ModbusTcpClient("x")\nprint(c.read_holding_registers(1, 2))\n'],
    ['file write and logging', 'import logging\nlogging.info("serial write to COM3")\nwith open("log.txt", "w") as f:\n    f.write("x")\n    f.writelines(["a"])\n'],
    ['MQTT publish to a non-printer topic', 'import paho.mqtt.publish as publish\npublish.single("lab/temperature", "21.5")\n'],
    ['DAQ input task started', 'import nidaqmx\nt = nidaqmx.Task()\nt.di_channels.add_di_chan("Dev1/port0")\nt.start()\n'],
  ]
  for (const [name, src] of LOOKALIKES) {
    test(`${name} is not a hit`, async () => {
      expect(pythonHits(src)).toEqual([])
      expect(pythonBlind(src)).toEqual([])
    })
  }
  test('exec, eval, import_module and __import__ beside a hardware library cannot be inspected', async () => {
    expect(pythonBlind('import nidaqmx\nexec(open("x.py").read())\n')).toEqual(['exec()'])
    expect(pythonBlind('import importlib\nm = importlib.import_module("serial")\n')).toEqual(['import_module()'])
    expect(pythonBlind('m = __import__("pymodbus.client")\n')).toEqual(['__import__()'])
    expect(pythonBlind('import serial\ncode = compile(src, "x", "exec")\n')).toEqual(['compile()'])
  })
  test('dynamic code with no hardware library, and methods named eval or compile, are fine', async () => {
    expect(pythonBlind('import re, torch\nre.compile("x")\nmodel.eval()\nprint(eval("1+1"))\n')).toEqual([])
    expect(pythonBlind('import serial\npattern = re.compile("x")\nmodel.eval()\nast.literal_eval("1")\n')).toEqual([])
  })
  test('python -c that imports a hardware library by name asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, `python -c "import importlib; m = importlib.import_module('serial'); m.Serial('COM3').write(b'x')"`)
    expect(w.asked).toEqual(['Hardware write check: could not inspect import_module() in python -c'])
  })
})

describe('finding 6: scripts, ipython, notebooks, .NET serial', () => {
  const DAQ_C = `python -c "import nidaqmx; t=nidaqmx.Task(); t.do_channels.add_do_chan('Dev1/port0/line0'); t.write(True)"\n`
  test('Write of a .ps1 holding a hardware python -c asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/flash.ps1', content: DAQ_C } as never)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (python -c) in flash.ps1'])
  })
  test('Write of a .sh that runs a hardware script asks', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/run.sh', content: '#!/bin/sh\npython drive.py\n' } as never)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py) in run.sh'])
  })
  test('Edit of a .bat that adds a hardware run asks', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO, 'C:/work/go.bat': '@echo off\r\nREM TODO\r\n' })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'C:/work/go.bat', old_string: 'REM TODO', new_string: 'python drive.py' } as never)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py) in go.bat'])
  })
  test('Write of a harmless script passes', async ($, on) => {
    const w = world(on, { 'C:/work/hello.py': HELLO })
    await start($)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/run.sh', content: 'echo hi > out.txt\npython hello.py\n' } as never)
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Write'])
  })
  const SCRIPTS = {
    'C:/work/drive.py': DAQ_DO,
    'C:/work/flash.ps1': 'Write-Host flashing\npython drive.py\n',
    'C:/work/flash.bat': '@echo off\r\npython "%~dp0drive.py"\r\n',
    'C:/work/run.sh': '#!/bin/sh\nset -e\npython drive.py\n',
    'C:/work/tools/root.ps1': 'python "$PSScriptRoot\\..\\drive.py"\n',
  }
  const RUNS: [string, 'ps' | 'sh'][] = [
    ['.\\flash.ps1', 'ps'],
    ['& .\\flash.ps1', 'ps'],
    ['. .\\flash.ps1', 'ps'],
    ['pwsh -File flash.ps1', 'ps'],
    ['powershell -NoProfile -ExecutionPolicy Bypass -File .\\flash.ps1', 'ps'],
    ['pwsh tools/root.ps1', 'ps'],
    ['cmd /c flash.bat', 'ps'],
    ['.\\flash.bat', 'ps'],
    ['bash run.sh', 'sh'],
    ['sh -e run.sh', 'sh'],
    ['./run.sh', 'sh'],
    ['source run.sh', 'sh'],
    ['cmd //c flash.bat', 'sh'],
    ['powershell -File flash.ps1', 'sh'],
  ]
  for (const [command, shell] of RUNS) {
    test(`${shell}: ${command} reads the script`, async ($, on) => {
      const w = world(on, SCRIPTS)
      await start($)
      const r = await (shell === 'ps' ? pwsh : bash)($, command)
      expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
      expect(r.deny).toBeDefined()
    })
  }
  test('a script that cannot be read asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await bash($, './missing.sh')
    expect(w.asked).toEqual(['Hardware write check: could not inspect missing.sh'])
  })
  test('a harmless script runs without asking', async ($, on) => {
    const w = world(on, { 'C:/work/build.ps1': 'npm run build\npython hello.py\n', 'C:/work/hello.py': HELLO })
    await start($)
    const r = await pwsh($, '.\\build.ps1')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
  })
  test('a script running itself stops at the depth limit and asks', async ($, on) => {
    const w = world(on, { 'C:/work/loop.sh': './loop.sh\n' })
    await start($)
    await bash($, './loop.sh')
    expect(w.asked).toEqual(['Hardware write check: could not inspect loop.sh (scripts nested too deep)'])
  })
  test('PowerShell .NET SerialPort writes ask', async ($, on) => {
    const w = world(on, {})
    await start($)
    await pwsh($, "$p = New-Object System.IO.Ports.SerialPort COM3,9600; $p.Open(); $p.WriteLine('G28')")
    await pwsh($, "[System.IO.Ports.SerialPort]::new('COM3').Write('x')")
    expect(w.asked).toEqual(['Hardware write: .NET SerialPort write', 'Hardware write: .NET SerialPort write'])
  })
  test('listing or reading serial ports in PowerShell passes', async ($, on) => {
    const w = world(on, {})
    await start($)
    await pwsh($, '[System.IO.Ports.SerialPort]::GetPortNames()')
    await pwsh($, "$p = [System.IO.Ports.SerialPort]::new('COM3'); $p.Open(); $p.ReadLine()")
    expect(w.asked).toEqual([])
  })
  test('ipython -c and ipython script.py are inspected', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await bash($, `ipython -c "from pymodbus.client import ModbusTcpClient; ModbusTcpClient('x').write_coil(1, True)"`)
    await bash($, 'ipython drive.py')
    expect(w.asked).toEqual(['Hardware write: pymodbus write_coil (python -c)', 'Hardware write: nidaqmx DO write (drive.py)'])
  })
  test('a Python script run by name is inspected', async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO })
    await start($)
    await bash($, './drive.py')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)'])
  })
  test('Write of a notebook with a hardware cell asks', async ($, on) => {
    const w = world(on, {})
    await start($)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/nb.ipynb', content: notebook('import nidaqmx\n', 'task = nidaqmx.Task()\ntask.do_channels.add_do_chan("Dev1/port0/line0")\ntask.write(True)\n') } as never)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write in nb.ipynb'])
  })
  test('Write of a harmless notebook passes', async ($, on) => {
    const w = world(on, {})
    await start($)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/nb.ipynb', content: notebook('import numpy as np\n', 'np.zeros(3)\n') } as never)
    expect(w.asked).toEqual([])
  })
  for (const command of ['jupyter execute nb.ipynb', 'jupyter nbconvert --to notebook --execute nb.ipynb', 'jupyter-nbconvert --execute nb.ipynb', 'papermill nb.ipynb out.ipynb -p n 3', 'python -m papermill nb.ipynb out.ipynb', 'ipython nb.ipynb']) {
    test(`${command} reads the notebook`, async ($, on) => {
      const w = world(on, { 'C:/work/nb.ipynb': notebook(DAQ_DO) })
      await start($)
      await bash($, command)
      expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (nb.ipynb)'])
    })
  }
  for (const command of ['jupyter nbconvert --to html nb.ipynb', 'jupyter lab']) {
    test(`${command} passes`, async ($, on) => {
      const w = world(on, { 'C:/work/nb.ipynb': notebook(DAQ_DO) })
      await start($)
      await bash($, command)
      expect(w.asked).toEqual([])
    })
  }
  test("a notebook's ! shell line and %run are followed", async ($, on) => {
    const w = world(on, { 'C:/work/drive.py': DAQ_DO, 'C:/work/a.ipynb': notebook('!python drive.py\n'), 'C:/work/b.ipynb': notebook('%run drive.py\n') })
    await start($)
    await bash($, 'jupyter execute a.ipynb')
    await bash($, 'jupyter execute b.ipynb')
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (drive.py)', 'Hardware write: nidaqmx DO write (drive.py)'])
  })
})

describe('finding 7: a notebook that cannot be read', () => {
  const edit = ($: Engine, new_source: string) =>
    $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:/work/big.ipynb', new_source, cell_type: 'code', edit_mode: 'insert' } as never)
  test('a new cell that writes asks', async ($, on) => {
    const w = world(on, {}, 'Cancel', false, false, ['C:/work/big.ipynb'])
    await start($)
    await edit($, 'task.write(True)\n')
    expect(w.asked).toEqual(['Hardware write check: could not inspect big.ipynb'])
  })
  test('a new cell that writes nothing passes', async ($, on) => {
    const w = world(on, {}, 'Cancel', false, false, ['C:/work/big.ipynb'])
    await start($)
    await edit($, 'df.plot()\n')
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['NotebookEdit'])
  })
  test('an Edit of a Python file that cannot be read asks when the new text writes', async ($, on) => {
    const w = world(on, {}, 'Cancel', false, false, ['C:/work/big.py'])
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'C:/work/big.py', old_string: '# TODO', new_string: 'task.write(True)' } as never)
    expect(w.asked).toEqual(['Hardware write check: could not inspect big.py'])
  })
})

describe('finding 8: the mode is published for other mods', () => {
  const guard = ($: Engine, args: string) =>
    $.command.run({ command: 'hw-guard', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as CommandRunInput)
  /** Each value the guard writes to $.state { plugin: 'hw-write-guard', key: 'mode' }, as mission-control would read it. */
  const published = (on: On) => {
    const values: unknown[] = []
    on('state.set', async ($, e, next) => {
      const write = e as unknown as { plugin: string; key: string; value: unknown }
      if (write.plugin === 'hw-write-guard' && write.key === 'mode') values.push(write.value)
      return next(e)
    })
    return values
  }
  test('ask at start, then each change /hw-guard makes', async ($, on) => {
    world(on, {})
    const values = published(on)
    await start($)
    expect(values).toEqual(['ask'])
    await guard($, 'off')
    await guard($, 'notify')
    await guard($, 'notify')
    expect(values).toEqual(['ask', 'off', 'notify'])
  })
  test('the stored mode is published at start', async ($, on) => {
    const w = world(on, {})
    const values = published(on)
    w.store.set('mode', 'off')
    await start($)
    expect(values).toEqual(['off'])
  })
  test('a change made in another session shows by the next tool call', async ($, on) => {
    const w = world(on, {})
    const values = published(on)
    await start($)
    w.store.set('mode', 'notify')
    await bash($, 'git status')
    expect(values).toEqual(['ask', 'notify'])
  })
  test('a mode change refused to a non-user publishes nothing', async ($, on) => {
    world(on, {})
    const values = published(on)
    await start($)
    await $.command.run({ command: 'hw-guard', args: 'off', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 100 } } as unknown as CommandRunInput)
    expect(values).toEqual(['ask'])
  })
})

describe('review follow-ups: no new questions on ordinary commands', () => {
  test('cat <<EOF > t.py (redirect after the marker) is read as the literal text', async ($, on) => {
    const w = world(on, { 'C:/work/t.py': HELLO })
    await start($)
    await bash($, `cat <<'EOF' > t.py\n${DAQ_DO}EOF\npython3 t.py`)
    expect(w.asked).toEqual(['Hardware write: nidaqmx DO write (t.py)'])
  })
  test('harmless heredoc text over a hardware script passes', async ($, on) => {
    const w = world(on, { 'C:/work/t.py': DAQ_DO })
    await start($)
    const r = await bash($, `cat <<'EOF' > t.py\n${HELLO}EOF\npython3 t.py`)
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
  })
  const QUIET = [
    'uv run drive.py',
    'poetry run python drive.py',
    'ipython kernel install --user --name lab',
    'jupyter nbconvert --to notebook --execute nb.ipynb --output out.ipynb',
    'source .venv/Scripts/activate && python drive.py',
    'mkdir -p out && python drive.py --out out/run1.csv',
  ]
  for (const command of QUIET) {
    test(`${command} passes`, async ($, on) => {
      const w = world(on, {
        'C:/work/drive.py': HELLO,
        'C:/work/nb.ipynb': notebook(HELLO),
        'C:/work/out.ipynb': notebook(DAQ_DO),
        'C:/work/.venv/Scripts/activate': 'export VIRTUAL_ENV="/c/work/.venv"\nexport PATH="$VIRTUAL_ENV/Scripts:$PATH"\nhash -r 2>/dev/null\n',
      })
      await start($)
      const r = await bash($, command)
      expect(r.deny).toBeUndefined()
      expect(w.asked).toEqual([])
    })
  }
  test('past the module cap asks rather than passing', async ($, on) => {
    const files: Record<string, string> = { 'C:/work/run.py': Array.from({ length: 45 }, (_, k) => `import m${k}\n`).join('') }
    for (let k = 0; k < 45; k++) files[`C:/work/m${k}.py`] = HELLO
    const w = world(on, files)
    await start($)
    await bash($, 'python run.py')
    expect(w.asked).toEqual(['Hardware write check: could not inspect modules run.py imports past the first 40'])
  })
})

describe('review follow-ups: loops end', () => {
  test('a notebook that runs itself stops at the depth limit and asks', async ($, on) => {
    const w = world(on, { 'C:/work/a.ipynb': notebook('!jupyter execute a.ipynb\n') })
    await start($)
    await bash($, 'jupyter execute a.ipynb')
    expect(w.asked).toEqual(['Hardware write check: could not inspect a.ipynb (scripts nested too deep)'])
  })
  test('modules that import each other are read once', async ($, on) => {
    const w = world(on, { 'C:/work/run.py': 'import a\n', 'C:/work/a.py': 'import b\n', 'C:/work/b.py': 'import a\n' })
    await start($)
    const r = await bash($, 'python run.py')
    expect(r.deny).toBeUndefined()
    expect(w.asked).toEqual([])
  })
})
