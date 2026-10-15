# my-claude-mods: setup guide for Claude Code at work

This bundle is a personal set of Claude Code mods, built and tested on **Claude Code 2.1.295 through 2.1.300, Windows 11**.
It is written for the Claude that installs it. Read it whole before running anything.

## Ground rules

- **Ask the user before each step that changes something.** That includes copying the folder into place, adding the marketplace, installing, disabling, and editing settings.
- **Check that the company allows it.** If managed settings or IT policy block local plugin marketplaces, stop and tell the user. Do not work around a policy.
- **Merge into existing config, never overwrite it.** Back up a file before editing it.
- **Never install anything that downloads code at runtime.** None of these mods does: none fetches from the network, and only cache-tax and prompt-upgrade make model calls (see below).
- **Present choices as clickable options** (AskUserQuestion). The user prefers not to type answers.
- **Never modify mod code on this machine.** Install the reviewed commit as it is. If a mod fails validate or its tests, recommend skipping it; if that mod is hw-write-guard, stop and tell the user.
- **The clone is live.** The marketplace is the folder itself, so an edit or `git pull` there changes what runs at the next `/reload-plugins`. Review before pulling.

## Install

From the unzipped bundle, in PowerShell:

```powershell
cd <unzipped>\work-bundle
.\install.ps1 -DryRun     # validates and runs every mod's tests, changes nothing
.\install.ps1             # copies to $HOME\src\claude-mods, adds the marketplace, installs
```

Options (lists can be comma-separated, e.g. `-Exclude "cc-arcade,savvy-progress"`):
- `-Exclude <mods>` leaves mods out. reflect-mod is always left out.
- `-Disable <mods>` installs them but switches them off, e.g. `-Disable filetree`.
- hw-write-guard can't be excluded or disabled without `-AllowNoHwGuard`. Use it only when the user confirms no hardware is attached.
- savvy-progress is installed switched off; `-EnableSavvyProgress` turns it on.
- `-DisableClashes` switches off enabled copies of any mod this run installs that come from other marketplaces (upstream cache-tax, redact, plan-progress, blast-radius, replay-theater, …), plus token-weather, which hides other mods' rows, each at the scope it's installed at. Without it, the script only lists them. **Ask the user first.**
- `-SkipTests` skips the tests.
- `-Force` moves an existing `$HOME\src\claude-mods` aside instead of stopping.

What it checks:
- Every mod name is checked before anything changes: an unknown mod, `-Disable reflect-mod`, or one mod in both lists stops the script.
- It warns when Claude Code is outside 2.1.295–2.1.300.
- A failing test in one of this marketplace's own mods (not vendored) stops the install.
- A failing test in a vendored mod is only a warning. Two vendored mods are known to fail here, the same as at home:
  - cc-arcade's tests use `bun:test`, which `claude plugin test` doesn't run.
  - filetree has one layout test that fails.
- If `my-claude-mods` is already registered at a different folder, the script stops and tells you how to remove it.

The script stops at the first failure. When it finishes, run `/reload-plugins` (or restart Claude).

If execution policy or a downloaded-file block stops `.\install.ps1`, don't bypass it: use the manual equivalent below, or ask the user.

Manual equivalent:
1. `claude plugin validate <dir>`
2. `claude plugin test <dir>\<mod>`
3. `claude plugin marketplace add <dir>`
4. `claude plugin install <mod>@my-claude-mods --scope user`

### If validate or a test fails (a different Claude Code version)

The mods use the function-hook API (`register(on)`, `$.<noun>.<op>`), which is still moving between versions.

1. Read the validator's message. It names the hook and the refused call.
2. Don't patch the mod here. Report the message to the user and recommend installing the rest with `-Exclude <mod>`.
3. If the failing mod is hw-write-guard, stop: don't install without it on a machine with hardware attached.
4. Fixes are made in the home repo and pulled here after review.

## What's in it

**Bold** marks the mods most useful for long sessions and multi-agent work.

| Mod | What you see / how to use it | Notes |
|---|---|---|
| **mission-control** | One status block above the prompt: `[SYS]` repo, branch, model, and the hardware guard's real mode (`[HW-GUARD ASK]` green, `NOTIFY` amber, `OFF` red, `?` until hw-write-guard has reported); `[CTL]` model and effort buttons; `[CTX]` context fill and the tools whose output fills it. `/ctx` opens a pane by tool, with the biggest outputs. `/ctx band` hides the `[CTX]` row. `/clean` turns tool rows into a checklist. While flightdeck's pane is open and shown, the block sits at the top of it instead, without `[CTX]` (flightdeck shows context); with another pane in front it returns to the band. | It also restyles tool rows (`[TOOL]`/`[READ]`/`[EDIT]`) and puts `[SYS]` in the spinner. It also notices a compaction from the drop in context fill, so `[CTX]` stays right where compaction hooks don't run (see "Org-managed Claude Code"). |
| **qa-jump** | `/qa` opens a pane listing every question asked, with the start of each answer, including questions typed while Claude is working and prompts other mods send for you (next-steps, prompt-upgrade's Run, auto-model's Redo). Its buttons scroll the transcript to the answer or to the question. | It only lists questions asked after it loaded. |
| **flightdeck** | A pane with subagents, permission checks, context, cost and rate limits. `/flightdeck` toggles it; `/flightdeck close`, `reset`, `layout auto\|compact\|wide\|mini`. | It opens itself at session start and sets a status-line entry (`flightdeck: ctx N%`). A permission question you refuse counts as denied. Its compaction count works without compaction hooks. |
| **plan-progress** | Progress bars above the prompt, with a strip per subagent. Each strip shows the agent's steps and percent (`3/8 · 38%`), and the bar's agent pill shows overall agent completion. `/progress`, `/progress-agents`, `/progress-clear`, `/plan-progress-autoclose`, `/progress-agent-steps on\|off`, `/progress-sounds on\|off`. | It adds the `plan_progress` and `progress_step` tools and a system-prompt section. After several edits with no bar it reminds Claude to open one; it never refuses an edit. Each new subagent's prompt gets one line asking it to report through `progress_step` if it has that tool; `/progress-agent-steps off` stops that line. Its `.wav` sounds play by starting `powershell` (no execution-policy flags); `/progress-sounds off` or the `sounds` option in `/config` silences them, which is the better default at work. Patched locally (marked `Modified for my-claude-mods` in its files). |
| **savvy-progress** | `/agents-info` opens a subagent panel. Its `progress` and `step` tools serve its `/savvy-flow` workflow, which is not in this bundle. | The installer installs it switched off, since plan-progress and flightdeck cover it; `-EnableSavvyProgress` turns it on. Its row stacks with the others. |
| **cache-tax** | When your own send (typed, from your phone, or a next-steps click) would rewrite an expired prompt cache on a context of 50k+ tokens, it drops that send once and shows the price; send again to pay it. Background-task notifications, scheduled prompts and peer messages are never dropped, only noted with their price. `/cache-tax guard warn` only warns. `/cache-tax` shows status. `/keepwarm` arms 6 hours, `/keepwarm 90m` a shorter window, `/keepwarm always` re-arms every session (remembered), `/keepwarm off` stops. | ⚠️ **Spends tokens:** keepwarm sends a tool-less fork (`$.model.fork`) over the transcript after 50 idle minutes. A cold write on your own model arms it automatically for 3 hours. It tracks your own model's cache, not turns auto-model sent elsewhere, and skips a ping while the last turn ran on another model. On very large contexts, decide with the user whether that's worth it. |
| **next-steps** | At the end of a turn, Claude offers 2–4 follow-ups as buttons, each with the exact prompt it sends shown under it (at most 200 characters). A click sends that prompt as yours; any sent prompt clears them. | It adds one always-loaded tool and one line to the system prompt. |
| **reflect-lite** | When the user corrects Claude ("no, don't…", "remember: …"), a `[LEARN]` row shows the whole rule and offers to save it to `~/.claude/CLAUDE.md`, the project's `CLAUDE.md`, or `~/.claude/skills/learned-rules/SKILL.md` (or Edit / Skip). | Matching is local; it makes no model calls. It doesn't offer a rule that looks like it holds a secret, and wraps `@path` text in backticks so it can't become a CLAUDE.md import. |
| **git-changes** | `/changes` opens a pane: branch, ahead/behind, staged, unstaged, untracked and conflicted files with +/- counts, recent commits. | Read-only `git`, and only while the pane is open. Needs `git` on PATH. |
| **filetree** | `/filetree` opens a file tree pane. Files Claude touched are highlighted, and turn green once committed. Enter and Space select or fold; they never open a file. Double-click (or Ctrl/Shift-click) opens a document normally, but on Windows a script opens in Notepad and a program, installer or shortcut is shown selected in Explorer: nothing runs. A selected file goes to Claude with your next prompt only. Closing the pane keeps it closed until `/filetree`. | It runs `find`, `du`, `sh`, `git`, `touch` and `rm` (its own marker files), and opens files through PowerShell. Git for Windows' Unix tools must be on PATH **ahead of** Windows' own `find.exe`. |
| **replay-theater** | After a turn with edits, a Replay row appears. `/replay` steps through the diffs. | Patched so its row stacks; see the band rule below. |
| **redact** | `/redact` shows its status. It swaps secrets in prompts, tool output, Claude's replies, CLAUDE.md files and memory for placeholders. It restores a secret only into a file that already holds that exact value (editing a config that contains it); writing a placeholder into a new file, a script, a notebook or a memory note is refused, and so is any shell command containing a placeholder, or a placeholder from before `/clear`, `/resume` or a restart. | Secrets only by default; personal data needs its `pii=true` option. To put a key into a new file, the user pastes it in. On org-managed Claude Code, CLAUDE.md and memory are scanned only if redact is listed in managed settings. |
| **blast-radius** | Holds risky **Bash** and **Monitor** commands (`rm -rf`, `find -delete`, `xargs rm`, `git reset --hard`, `git clean`, `git checkout/restore -- .`, force push including `-fu`, migrations), also inside `bash -c`, `$(…)`, `timeout`/`sudo`/`env` wrappers and after a single `&`; shows what they'd change, and asks Proceed or Cancel. | PowerShell commands are not covered. On Windows it measures with Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`, else Git's own `bin\bash.exe`), never WSL's `bash`; when it can't measure, it says so. Any error while holding refuses the command. **Patched:** upstream listed pending migrations by running the project's own code before the permission check; this copy only names the command. Its classifier reads every word, so a commit message containing a migrate command gets held too; reword the message. While it's holding a command, its question replaces the band; that's deliberate. |
| **shared-edit-guard** | Asks before Claude edits a file another tool (Gemini, an editor) changed in the last 10 minutes, including edits made by a shell command (`Set-Content`, `Out-File`, redirects, `sed -i`, …) or an MCP write tool. Cancel sticks until the user picks "Edit anyway" or the change is 10 minutes old, even after Claude re-reads the file. | A change during Claude's own shell command counts as Claude's only when that command looks like it writes and names the file. That keeps the guard working with many parallel agents, but it also asks after Claude's own folder-wide formatter or `git pull`. |
| **hw-write-guard** | Asks before code that writes to hardware runs or is written: nidaqmx DO/AO, pymodbus coil/register writes, pyserial and PowerShell `SerialPort` writes, printer MQTT. It reads the script, the local modules it imports (3 levels, 40 files), `.ps1`/`.bat`/`.sh` scripts and notebooks being written or run, `python -c`, `Start-Process`, `ipython`/`jupyter`/`papermill`, and Monitor commands. `/hw-guard` shows its status. `/hw-guard notify` stops the questions (a toast names each write and it runs), `/hw-guard off` skips the check, `/hw-guard ask` restores it; the choice is kept per machine, and mission-control shows it. **Leave it on `ask`** on any machine with real hardware attached, unless the user says otherwise. | It fails closed. It asks ("could not inspect …") when it can't read a script or module, a file was changed earlier in the same command, an unknown `python -m` module or stdin code runs, or `exec`/`eval` sits near a hardware library. Not covered: Python that starts other processes (`subprocess`, `os.system`), files changed by `git pull`/`checkout`/unzip before a run, imports deeper than 3 levels or through `sys.path`/`PYTHONPATH`, extensionless scripts, `%%bash` notebook cells, compiled programs (`dotnet run`). It is not a sandbox. |
| **agent-governor** | While subagents run, a `[GOV]` row shows how many are running, the peak, and new tokens (cache reads not counted). It toasts when running agents exceed 6, one agent exceeds 300k, or the session exceeds 3M. `/governor` shows status; `/governor max N`, `budget N`, `session N` (accepts `300k`, `3m`). | Watch-and-warn by default; it never blocks. Opt-in: `/governor caps on` asks before starting another agent at the cap (parallel starts count) and stops agents over budget while still letting them hand back, message or stop; `/governor route Explore=sonnet` picks a model per agent type when the call gave none (sonnet, opus, haiku, fable or a `claude-` id only). |
| **checkpoint** | At every main-loop compaction it writes `.claude/handoff/<time>.md` and `latest.md` (goal, open tasks, files touched, recent errors) and asks the summary to keep them. A fresh session with a recent note it wrote itself shows `[CKPT]` Resume (fills the prompt, doesn't send) / Dismiss; a note that came with a cloned repo is never offered. `/handoff` writes a note now. | Never blocks or triggers a compaction. The folder is git-ignored. Notes are not deleted automatically (mods can't delete files); they're about 2 KB each. On org-managed Claude Code the automatic notes need compaction hooks, so only `/handoff` works there. |
| **retry-breaker** | When Claude or a subagent fails the same call 3× in a row (busy COM port, timeout, flaky test), even with a wait or check between tries, it shows one toast and a `[LOOP]` row with Dismiss. `/retry-breaker`, `/retry-breaker threshold N`, `/retry-breaker off\|on`. | Warn only; it never blocks. A streak ends when that call succeeds, or after 5 other calls succeed in a row. |
| **auto-model** | Picks the model per prompt with local rules: quick questions to Haiku, writing and explaining to Sonnet, building and fixing to Opus. Follow-ups ("yes", "push it") and quick prompts that ask for an action ("…and delete them", "reset the board") stay on the current model. After a switched turn, an `[AUTO]` row offers Redo with your own model, or Dismiss. `/automodel` shows each model's cache (age and tokens) and what switching would cost against staying; `/automodel off\|on`. | No model calls. It switches only when the other model's prompt-cache re-read costs little, counting how much of the chat each cache still holds: that model's cache is warm and holds as much as yours, yours went cold anyway (new session, 1h+ idle), Haiku under 75k tokens of context, Opus re-reading under 50k. A resumed chat counts as warm. It routes only first-party model names (`claude-…`), never Bedrock, Vertex or gateway names or a fallback model, and stops for the session if a switched turn errors or is refused. It changes only the main loop's requests for that one turn, so subagents and Fable sessions are left alone, and `/model` and mission-control's `[SYS]` keep showing your own pick. A switched turn runs at that model's default effort. The whole conversation always goes along; only Opus 5.5's earlier hidden reasoning is unreadable to the other model, and Opus reads it again on its next turn. Limits in `/config` (`haikuUnderTokens`, `switchUnderTokens`). Skip it if the account restricts which models it may use. |
| prompt-upgrade | `/improve <prompt>`, or `/improve` alone for your last prompt, opens a pane: 2–4 questions with clickable answers and an "Anything else?" field, then your prompt and the improved one side by side, with Run, Edit first, Copy, Start over and Close. | ⚠️ **Makes model calls:** two Sonnet calls (`$.model.complete`) per use, only when asked; the model is in `/config`. It's `/improve` because `/upgrade` is a built-in command. Run sends the improved prompt as yours; Edit first puts it in the prompt box instead. |
| todays-report | `/report [today\|week\|month\|year\|all]` opens a pane: tasks finished (main-loop turns that ended with an answer), time Claude worked, where the work went (by the most telling tool used: email, code, documents, research…), models, API-equivalent cost and tokens, and the day streak. Time saved and its value are estimates: tasks × minutes per task, at an hourly rate. | No model calls. It counts in the plugin's own store from install on, one entry per day; earlier history isn't read back. Defaults are 10 min per task and $50/h, both in `/config`. |
| cc-arcade | `/arcade`: games and a pet above the prompt while Claude works. `/arcade list\|random\|auto\|colorblind\|stop\|<game>`. | Optional at work. The board fits the band and leaves room for other rows. A pet saved by version 0.2.0 or earlier had broken numbers and is replaced by a new egg once. |
| chat-bubbles | Messenger-style chat: Your prompts in right-aligned bubbles, Claude's replies in tinted cards, tool rows only stand out while running or failing. `/bubbles` opens a studio (441 palettes, search, mixer); `/bubbles <name>`, `random`, `next`, `bg <#hex>`, `base dark\|light`, `prompt bubble\|frame\|native`, `off`. | Changes nothing until a theme is picked. No network or processes. Vendored @ 5597448 (MIT) and patched so its footer keeps plan-progress's button; its backdrop pads only its own pane. See "App look" below. |

`reflect-mod` is in the repo but never installed: reflect-lite replaces it, and it makes a Haiku call per prompt. The installer always skips it and the zip leaves it out.

## Org-managed Claude Code

Where an organization manages Claude Code, some hooks run only for plugins listed in managed settings (`claude plugin validate <mod>` names them). For a user-installed copy:
- plan-progress's and next-steps' system-prompt lines and plan-progress's end-of-turn check don't run. The bars and buttons still work when Claude calls their tools.
- redact can't scan CLAUDE.md and memory or add its note to Claude's environment; every other row is still scanned.
- checkpoint writes notes only with `/handoff`.
- mission-control and flightdeck notice compactions from the drop in context fill instead.

If those parts matter, ask IT to list the mods in managed settings.

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
