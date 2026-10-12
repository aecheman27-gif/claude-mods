# my-claude-mods: setup guide for Claude Code at work

This bundle is a personal set of Claude Code mods, built and tested on **Claude Code 2.1.295, Windows 11**.
It is written for the Claude that installs it. Read it whole before running anything.

## Ground rules

- **Ask the user before each step that changes something.** That includes copying the folder into place, adding the marketplace, installing, disabling, and editing settings.
- **Check that the company allows it.** If managed settings or IT policy block local plugin marketplaces, stop and tell the user. Do not work around a policy.
- **Merge into existing config, never overwrite it.** Back up a file before editing it.
- **Never install anything that downloads code at runtime.** None of these mods does: none fetches from the network, and only cache-tax makes model calls (see below).
- **Present choices as clickable options** (AskUserQuestion). The user prefers not to type answers.

## Install

From the unzipped bundle, in PowerShell:

```powershell
cd <unzipped>\work-bundle
.\install.ps1 -DryRun     # validates and runs every mod's tests, changes nothing
.\install.ps1             # copies to $HOME\src\claude-mods, adds the marketplace, installs
```

Options (lists can be comma-separated, e.g. `-Exclude "cc-arcade,hw-write-guard"`):
- `-Exclude <mods>` leaves mods out. reflect-mod is always left out.
- `-Disable <mods>` installs them but switches them off, e.g. `-Disable savvy-progress`.
- `-DisableClashes` switches off enabled copies of the same mods from other marketplaces: the playground's blast-radius and replay-theater, and token-weather, which hides other mods' rows. Without it, the script only lists them. **Ask the user first.**
- `-SkipTests` skips the tests.
- `-Force` moves an existing `$HOME\src\claude-mods` aside instead of stopping.

What it checks:
- A failing test in one of this marketplace's own mods (not vendored) stops the install.
- A failing test in a vendored mod is only a warning. Two vendored mods are known to fail here, the same as at home:
  - cc-arcade's tests use `bun:test`, which `claude plugin test` doesn't run.
  - filetree has one layout test that fails.
- If `my-claude-mods` is already registered at a different folder, the script stops and tells you how to remove it.

The script stops at the first failure. When it finishes, run `/reload-plugins` (or restart Claude).

Manual equivalent:
1. `claude plugin validate <dir>`
2. `claude plugin test <dir>\<mod>`
3. `claude plugin marketplace add <dir>`
4. `claude plugin install <mod>@my-claude-mods --scope user`

### If validate or a test fails (a different Claude Code version)

The mods use the function-hook API (`register(on)`, `$.<noun>.<op>`), which is still moving between versions.

1. Read the validator's message first. It names the hook and the refused call.
2. Load the `plugin-authoring` skill. It writes this build's API types to a `claude-code.d.ts` file.
3. Grep that file for the event or noun named in the error, and fix the mod against it.
4. Re-run validate and test before installing.
5. If a mod can't be fixed quickly, install the rest with `-Exclude <mod>` and report it to the user.

## What's in it

**Bold** marks the mods most useful for long sessions and multi-agent work.

| Mod | What you see / how to use it | Notes |
|---|---|---|
| **mission-control** | One status block above the prompt: `[SYS]` repo, branch, model, hw-guard; `[CTL]` model and effort buttons; `[CTX]` context fill and the tools whose output fills it. `/ctx` opens a pane by tool, with the biggest outputs. `/ctx band` hides the `[CTX]` row. `/clean` turns tool rows into a checklist. While flightdeck's pane is open the block sits under its session log instead, without `[CTX]` (flightdeck shows context). | It also restyles tool rows (`[TOOL]`/`[READ]`/`[EDIT]`) and puts `[SYS]` in the spinner. |
| **qa-jump** | `/qa` opens a pane listing every question asked, with the start of each answer. Its buttons scroll the transcript to the answer or to the question. | It only lists questions asked after it loaded. |
| **flightdeck** | A pane with subagents, permission checks, context, cost and rate limits. `/flightdeck` toggles it; `/flightdeck close`, `reset`, `layout auto\|compact\|wide\|mini`. | It opens itself at session start and sets a status-line entry (`flightdeck: ctx N%`). |
| **plan-progress** | Progress bars above the prompt, with a strip per subagent. Each strip shows the agent's steps and percent (`3/8 · 38%`), and the bar's agent pill shows overall agent completion. `/progress`, `/progress-agents`, `/progress-clear`, `/plan-progress-autoclose`, `/progress-agent-steps on\|off`. | It adds the `plan_progress` and `progress_step` tools and a system-prompt section. Steps come free from a subagent's TodoWrite or TaskCreate/TaskUpdate. Otherwise each new subagent's prompt gets one line asking it to report through `progress_step`; `/progress-agent-steps off` stops that line. Its `.wav` sounds play by starting `powershell` on Windows. Patched locally; see "Modified for my-claude-mods". |
| **savvy-progress** | `/agents-info` opens a subagent panel. Its `progress` and `step` tools serve its `/savvy-flow` workflow, which is not in this bundle. | The installer installs it enabled. plan-progress and flightdeck cover it, so it's usually kept off; skip it with `-Disable savvy-progress`. |
| **cache-tax** | When a send would rewrite an expired prompt cache on a context of 50k+ tokens, it drops that send once and shows the price; send again to pay it. `/cache-tax guard warn` only warns. `/cache-tax` shows status. `/keepwarm` arms 6 hours, `/keepwarm 90m` a shorter window, `/keepwarm always` re-arms every session (remembered), `/keepwarm off` stops. | ⚠️ **Spends tokens:** keepwarm sends a tool-less fork (`$.model.fork`) over the transcript after 50 idle minutes. A cold write arms it automatically for 3 hours. On very large contexts, decide with the user whether that's worth it. |
| **next-steps** | At the end of a turn, Claude offers 2–4 follow-ups as buttons. A click sends one; any sent prompt clears them. | It adds one tool and one line to the system prompt. |
| **reflect-lite** | When the user corrects Claude ("no, don't…", "remember: …"), a `[LEARN]` row offers to save the rule to `~/.claude/CLAUDE.md`, the project's `CLAUDE.md`, or `~/.claude/skills/learned-rules/SKILL.md` (or Edit / Skip). | Matching is local; it makes no model calls. |
| **git-changes** | `/changes` opens a pane: branch, ahead/behind, staged, unstaged, untracked and conflicted files with +/- counts, recent commits. | Read-only `git`, and only while the pane is open. Needs `git` on PATH. |
| **filetree** | `/filetree` opens a file tree pane. Files Claude touched are highlighted, and turn green once committed. | It runs `find`, `du`, `sh`, `git`, `touch` and `rm` (its own marker files), and opens files through PowerShell. Git for Windows' Unix tools must be on PATH **ahead of** Windows' own `find.exe`. |
| **replay-theater** | After a turn with edits, a Replay row appears. `/replay` steps through the diffs. | Patched so its row stacks; see the band rule below. |
| **redact** | `/redact` shows its status. It swaps secrets in prompts, tool output and Claude's replies for placeholders, and restores them only inside file edits (never in shell commands). | Secrets only by default; personal data needs its `pii=true` option. |
| **blast-radius** | Holds risky **Bash** commands (`rm -rf`, `git reset --hard`, `git clean`, `git checkout/restore -- .`, force push, migrations), shows what they'd change, and asks Proceed or Cancel. | PowerShell commands are not covered. It needs `bash`, `sleep` and `git` on PATH, and it refuses on any error, so a missing `sleep` holds every risky command. **Patched:** upstream listed pending migrations by running the project's own code before the permission check; this copy only names the command. Its classifier reads every word, so a commit message containing a migrate command gets held too; reword the message. While it's holding a command, its question replaces the band; that's deliberate. |
| **shared-edit-guard** | Asks before Claude edits a file another tool (Gemini, an editor) changed in the last 10 minutes. | A change during Claude's own shell command counts as Claude's only when that command names the file. That keeps the guard working with many parallel agents, but it also asks after Claude's own folder-wide formatter or `git pull`. |
| **hw-write-guard** | Asks before code that writes to hardware runs or is written: nidaqmx DO/AO, pymodbus coil/register writes, pyserial writes, printer MQTT. `/hw-guard` shows its status. `/hw-guard notify` stops the questions (a toast names each write and it runs), `/hw-guard off` skips the check, `/hw-guard ask` restores it; the choice is kept per machine. **Leave it on `ask`** on any machine with real hardware attached, unless the user says otherwise. | It fails closed. It asks ("could not inspect …") when it can't read a script, an unknown `python -m` module, or code fed on stdin. |
| **agent-governor** | While subagents run, a `[GOV]` row shows how many are running, the peak, and new tokens (cache reads not counted). It toasts when running agents exceed 6, one agent exceeds 300k, or the session exceeds 3M. `/governor` shows status; `/governor max N`, `budget N`, `session N` (accepts `300k`, `3m`). | Watch-and-warn by default; it never blocks. Opt-in: `/governor caps on` asks before starting another agent at the cap and stops agents over budget; `/governor route Explore=sonnet` picks a model per agent type when the call gave none. |
| **checkpoint** | At every main-loop compaction it writes `.claude/handoff/<time>.md` and `latest.md` (goal, open tasks, files touched, recent errors) and asks the summary to keep them. A fresh session with a recent note shows `[CKPT]` Resume (fills the prompt, doesn't send) / Dismiss. `/handoff` writes a note now. | Never blocks or triggers a compaction. The folder is git-ignored. Notes are not deleted automatically (mods can't delete files); they're about 2 KB each. |
| **retry-breaker** | When Claude or a subagent fails the same call 3× in a row (busy COM port, timeout, flaky test), it shows one toast and a `[LOOP]` row with Dismiss. `/retry-breaker`, `/retry-breaker threshold N`, `/retry-breaker off\|on`. | Warn only; it never blocks. |
| cc-arcade | `/arcade`: games and a pet above the prompt while Claude works. `/arcade list\|random\|auto\|colorblind\|stop\|<game>`. | Optional at work. |
| chat-bubbles | Messenger-style chat: Your prompts in right-aligned bubbles, Claude's replies in tinted cards, tool rows only stand out while running or failing. `/bubbles` opens a studio (441 palettes, search, mixer); `/bubbles <name>`, `random`, `next`, `bg <#hex>`, `base dark\|light`, `prompt bubble\|frame\|native`, `off`. | Changes nothing until a theme is picked. No network or processes. Vendored @ 5597448 (MIT) and patched so its footer keeps plan-progress's button. See "App look" below. |

`reflect-mod` is left out of the bundle: reflect-lite replaces it, and it makes a Haiku call per prompt.

## Long sessions and multi-agent work

- Watch `[CTX]`, and open `/ctx` when it climbs. It shows which tool outputs (big Bash logs, file reads) are eating the window before you compact.
- Use `/qa` to find an earlier answer in a long transcript instead of scrolling.
- Keep flightdeck docked for running agents and cost. plan-progress shows a strip per subagent.
- Before a long break, `/keepwarm 90m` avoids paying to rewrite the cache. `/keepwarm off` when you're done for the day.

## App look (optional, ask the user first)

This setup makes Claude look less like a terminal. Files are in `work-bundle/look/`. Each step is separate; do only the ones the user approves.

1. **Chat look:** after install, run `/bubbles tokyo night`, then `/bubbles bg #1a1b26` so the bubbles sit on the window's background.
2. **Claude Code colors:** copy `look/tokyo-night.json` to `~/.claude/themes/` (create the folder), then set `"theme": "custom:tokyo-night"` in `~/.claude/settings.json` (merge, don't overwrite). Restart Claude once if the themes folder is new. In `/theme`, Ctrl+E edits it with a live preview.
3. **Fullscreen layout:** `"tui": "fullscreen"` in settings (or `/tui fullscreen`): the prompt is fixed at the bottom, mouse scrolling, no flicker. In Windows Terminal, Ctrl+L redraws if old text is left behind. `/tui default` undoes it.
4. **Windows Terminal "Claude" profile:** copy `look/claude-wt-fragment.json` to `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\ClaudeLook\claude.json` (a new file; Windows Terminal's own settings.json is not touched). Restart Windows Terminal; "Claude" appears in the profile list, with Tokyo Night colors, wide padding, no scrollbar and slight blur. It runs `powershell -NoExit -Command claude`; change `commandline` if Claude starts another way at work. `wt -p "Claude"` opens it. Don't use `--focus`: it hides the title bar, so the window can't be dragged or minimized with the mouse (Win+↓ minimizes; Ctrl+Shift+P → "Toggle focus mode" brings the bar back). If Windows Terminal flags `font.cellHeight`, delete that key.

To undo: `/bubbles off`, `/theme dark`, `/tui default`, delete the `ClaudeLook` fragment folder.

## Rules for changing these mods (learned building them)

1. **Band rows must stack.** In a `ui.render` hook for `AbovePrompt`, call `const below = await next(e)` and return your row *above* `below`. Never return only your own row, or you hide every other mod's row. Upstream token-weather and replay-theater did exactly that.
2. **Drawing is pure.** A `ui.render` hook may read state but never write it; the engine refuses the write. Record state in other events (`session.append`, `tool.call`, `prompt.submit`, `session.measure`) or in button handlers.
3. **`$` and `on` stay in the module's `register` file.** The validator does not follow `$` across an import. Helper files hold pure functions only.
4. **To prefix the spinner, rewrite its props** (`next({ ...e, props: { ...p, word: '[SYS] ' + p.word } })`). Wrapping its tree in a row puts the prefix on its own line.
5. **Give gating hooks a `.catch`** (`tool.call`, `prompt.submit`, `session.append`). The validator lists hooks without one but doesn't require it, and some vendored mods skip it. In this marketplace's own mods, observers replay with `.catch(($, e, next) => next(e))` and guards deny on failure with `next.called ? next(e) : { deny }`.
6. **Tests:**
   - Run `claude plugin test <mod>`.
   - Stub engine ops with `on('<noun>.<op>', ...)` returning `{ value }`.
   - The engine passes Windows paths with backslashes, so normalize them in fs stubs.
   - A test cannot scroll the transcript (`$.ui.scroll` to a message has no implementation in the test kit).
7. **On Windows, the Bash tool's heredocs can drop backslashes.** Write or patch regexes like `/\\/g` with the file editor, not a heredoc.

## Not in the bundle (set up separately if the user wants)

- **Ctrl+V pastes screenshots.** Add `{"context":"Chat","bindings":{"ctrl+v":"chat:imagePaste"}}` to `~/.claude/keybindings.json`. Then in Windows Terminal's settings.json, unbind `ctrl+v` (`{"id": null, "keys": "ctrl+v"}`) and move `Terminal.PasteFromClipboard` to `ctrl+shift+v`. Back up both files first.
- **A desktop launcher** (`Claude.bat`): checks for updates once a day, then resume or new chat. It depends on how Claude is installed at work, so rebuild it there rather than copying it.
