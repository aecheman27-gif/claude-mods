import { expect, test } from 'claude-code/testing'
import { openCommand } from '../hooks/open'

test('open keeps file and URL targets literal on every platform', () => {
  for (const os of ['linux', 'darwin', 'win32'] as const) {
    const target = os === 'win32' ? 'C:/Models/A & %NAME%/dax.ts' : '/work/A & B/dax.ts'
    const { argv, init } = openCommand(os, target)
    if (os === 'win32') {
      expect(init.env?.PANE_OPEN_TARGET).toBe('C:\\Models\\A & %NAME%\\dax.ts')
      expect(argv.at(-1)).toContain('UseShellExecute = $true')
      expect(argv.at(-1)).toContain("$ErrorActionPreference = 'Stop'")
      const url = 'https://example.test/path?q=a%20b&next=%NAME%'
      expect(openCommand(os, url).init.env?.PANE_OPEN_TARGET).toBe(url)
    } else {
      expect(argv.at(-1)).toBe(target)
      if (os === 'linux') expect(argv[2]).toContain('setsid -f -w')
    }
  }
})

test('on Windows a file that could run is never opened with its default action', () => {
  const how = (name: string, pathext = '') => {
    const script = openCommand('win32', `C:/lab/${name}`, pathext).argv.at(-1) ?? ''
    return script.includes('notepad.exe') ? 'edit' : script.includes('explorer.exe') ? 'reveal' : 'open'
  }
  for (const name of ['run.py', 'RUN.BAT', 'x.cmd', 'a.ps1', 'a.vbs', 'a.js', 'a.wsf', 'a.sh', 'a.reg', 'a.hta', 'a.ahk', 'x.bat. ', '.cmd']) expect(`${name}: ${how(name)}`).toBe(`${name}: edit`)
  for (const name of ['a.exe', 'a.com', 'a.msi', 'a.lnk', 'a.url', 'a.scr', 'a.cpl', 'a.msc', 'a.jar', 'a.appref-ms']) expect(`${name}: ${how(name)}`).toBe(`${name}: reveal`)
  for (const name of ['a.txt', 'a.csv', 'a.pdf', 'a.docx', 'a.ts', 'README']) expect(`${name}: ${how(name)}`).toBe(`${name}: open`)
  expect(how('rig.tool', '.COM;.EXE;.TOOL')).toBe('edit')
  const { argv, init } = openCommand('win32', 'C:/lab/a & %X%.bat')
  expect(argv.join(' ')).not.toContain('a & %X%')
  expect(init.env?.PANE_OPEN_TARGET).toBe('C:\\lab\\a & %X%.bat')
})
