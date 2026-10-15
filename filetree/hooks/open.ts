export const LINUX_LAUNCH = 'setsid -f -w "$@" </dev/null >/dev/null 2>&1 & p=$!; sleep 1; kill -0 "$p" 2>/dev/null && exit 0; wait "$p"'

export const LINUX_OPEN = [
  'set -f',
  'f=$1',
  'if command -v gio >/dev/null; then',
  '  if [ -f "$f" ] && command -v file >/dev/null && encoding=$(file -b --mime-encoding -- "$f") && [ -n "$encoding" ] && [ "$encoding" != binary ]; then',
  '    case $(gio info -a standard::content-type -- "$f" | sed -n \'s/.*standard::content-type: //p\') in',
  '      video/* | audio/*)',
  '        app=$(xdg-mime query default text/plain)',
  '        IFS=:',
  '        for dir in "${XDG_DATA_HOME:-$HOME/.local/share}" ${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do',
  '          [ -n "$app" ] && [ -f "$dir/applications/$app" ] && exec gio launch "$dir/applications/$app" "$f"',
  '        done',
  '        echo "No text/plain desktop application found for $f" >&2',
  '        exit 1',
  '        ;;',
  '    esac',
  '  fi',
  '  if (exec gio open "$f"); then exit 0; fi',
  'fi',
  'exec xdg-open "$f"',
].join('\n')

const WIN_OPEN = "$ErrorActionPreference = 'Stop'; [Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{ FileName = $env:PANE_OPEN_TARGET; UseShellExecute = $true }) | Out-Null"
// A file Windows' default action would run opens in Notepad (a script) or is shown in Explorer (the rest), never with that action.
const WIN_EDIT = "$ErrorActionPreference = 'Stop'; [Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{ FileName = (Join-Path $env:SystemRoot 'System32\\notepad.exe'); Arguments = [char]34 + $env:PANE_OPEN_TARGET + [char]34; UseShellExecute = $true }) | Out-Null"
const WIN_REVEAL = "$ErrorActionPreference = 'Stop'; [Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{ FileName = (Join-Path $env:SystemRoot 'explorer.exe'); Arguments = '/select,' + [char]34 + $env:PANE_OPEN_TARGET + [char]34; UseShellExecute = $true }) | Out-Null"
const WIN_SCRIPTS = new Set(['bat', 'cmd', 'ps1', 'psm1', 'psd1', 'psc1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'ws', 'sct', 'hta', 'reg', 'py', 'pyw', 'sh', 'bash', 'pl', 'rb', 'php', 'tcl', 'ahk', 'au3'])
const WIN_PROGRAMS = new Set(['exe', 'com', 'scr', 'cpl', 'pif', 'msi', 'msp', 'mst', 'msc', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'application', 'appref-ms', 'gadget', 'lnk', 'url', 'website', 'scf', 'jar', 'pyc', 'pyo', 'pyz', 'chm', 'diagcab', 'xbap', 'xll', 'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms'])
const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i

export function winOpener(target: string, pathext = ''): 'open' | 'edit' | 'reveal' {
  if (URL_TARGET.test(target)) return 'open'
  const name = (target.split(/[\\/]/).pop() ?? '').replace(/[. ]+$/, '')
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!ext) return 'open'
  if (WIN_PROGRAMS.has(ext)) return 'reveal'
  return WIN_SCRIPTS.has(ext) || pathext.toLowerCase().split(';').includes(`.${ext}`) ? 'edit' : 'open'
}

export function openCommand(os: 'linux' | 'darwin' | 'win32', target: string, pathext = '') {
  const how = os === 'win32' ? winOpener(target, pathext) : 'open'
  const argv = os === 'linux'
    ? ['sh', '-c', LINUX_LAUNCH, 'sh', 'sh', '-c', LINUX_OPEN, 'sh', target]
    : os === 'darwin'
      ? ['open', '--', target]
      : ['powershell', '-NoProfile', '-NonInteractive', '-Command', how === 'edit' ? WIN_EDIT : how === 'reveal' ? WIN_REVEAL : WIN_OPEN]
  return {
    argv,
    init: {
      timeoutMs: 10_000,
      ...(os === 'win32' ? { env: { PANE_OPEN_TARGET: URL_TARGET.test(target) ? target : target.replace(/\//g, '\\') } } : {}),
    },
  }
}
