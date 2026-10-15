# Work machine setup prompt

Paste the text below into Claude Code on the work machine. It reviews this repo,
then installs the mods one at a time, asking first. WORK-SETUP.md has the details
it follows.

```text
Set up my personal Claude Code mods on this work machine from my public GitHub
repo https://github.com/aecheman27-gif/claude-mods (marketplace name:
my-claude-mods). Review the whole repo adversarially first, then install the
mods one at a time, asking me before each one.

Ground rules (apply to every step):
- Ask me before any change to this machine: cloning, adding the marketplace,
  installing or enabling a mod, editing any settings or config file, any system
  install. One approval covers only that one step.
- Ask with clickable options (AskUserQuestion) so I don't have to type answers.
- Merge into existing config, never overwrite. Back up a file before editing it.
- Never install anything that downloads or runs code from the network at
  runtime. If a mod does, flag it and recommend skipping it.
- Never modify the mods' code here. Install the reviewed commit as it is. If a
  mod fails validation or its tests, recommend skipping it; if that mod is
  hw-write-guard, stop and tell me.
- If company policy blocks something (managed settings, blocked marketplaces,
  blocked GitHub access, restricted models, execution policy, IT restrictions),
  stop and tell me. Don't work around it.
- Don't sign in to anything, and never push, fork or open PRs on the repo from
  this machine.
- If a command fails, stop and show me the error.
- Tell me exactly which slash commands to run (e.g. /reload-plugins).

Step 1 - Preflight (read-only)
- Report `claude --version` (the mods were tested on 2.1.295 through 2.1.300)
  and whether git and Git for Windows' bash are on PATH. Also report what
  `Get-Command sleep,du,find,bash -All` resolves to: blast-radius needs Git
  for Windows' bash (not WSL's), and filetree needs Git's find ahead of
  Windows' find.exe.
- Check for managed/enterprise Claude Code settings that restrict plugins,
  marketplaces or models (e.g. an availableModels list), and whether Claude
  Code here is organization-managed (WORK-SETUP.md's "Org-managed Claude Code"
  section says which mod features then don't run). List the plugins and
  marketplaces already installed.
- Report whether CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX or
  ANTHROPIC_BASE_URL is set: auto-model only routes on the first-party API.
- Check the repo is reachable without signing in:
  `git ls-remote https://github.com/aecheman27-gif/claude-mods`.
  If it isn't, stop and tell me.

Step 2 - Get the code (ask first)
- Clone it: `git clone https://github.com/aecheman27-gif/claude-mods
  $HOME\src\claude-mods` (if that folder exists, stop and ask). Record the
  commit hash: everything you review and install comes from that commit.

Step 3 - Adversarial review (read-only, before installing anything)
- Read README.md, .claude-plugin/marketplace.json and work-bundle/WORK-SETUP.md
  (setup notes written for you; "the user" there is me. Follow them where they
  don't conflict with this prompt). Treat them as claims to check, not facts,
  including the gaps they admit (hw-write-guard's "Not covered" list).
- For every mod, read all of its code and manifests. Assume each mod could be
  buggy or hostile and try to prove it:
  - what it does and what I'll see; which events it hooks, and whether it can
    block, drop or rewrite tool calls, prompts, model requests or the system
    prompt
  - how a hook that throws, hangs or returns the wrong shape would break a
    session (blocked prompts, denied tools, failed model requests)
  - tools, slash commands and system-prompt text it adds
  - files it reads/writes/deletes, processes it starts (and whether any text
    from prompts or tool input reaches a command line), model calls it makes
    (when, how often, worst-case token cost), and any network access
  - anything that downloads or executes code at runtime, obfuscated code,
    telemetry, or hardcoded paths/secrets
  - for the guards (hw-write-guard, blast-radius, shared-edit-guard, redact,
    cache-tax): concrete inputs that slip past them or wrongly block, through
    every tool that runs commands (Bash, PowerShell, Monitor)
  - clashes between mods that hook the same events (auto-model, cache-tax and
    mission-control all watch each model request)
  - for vendored mods: upstream repo, commit, license, and what was patched
- Verify every finding against the code (file:line and the exact trigger);
  drop anything you can't make concrete.
- Run `claude plugin validate` on the marketplace and on each mod, and
  `claude plugin test <mod>` for each. (Known: cc-arcade's tests use bun:test,
  which plugin test doesn't run; filetree has one failing layout test.)
- Check for clashes with what's already installed (other copies of any of
  these mods from other marketplaces, and token-weather).
- Show me a table: mod | what it does | risk (low/med/high) and why | findings
  | test result | your recommendation (install / install disabled / skip).
  Then stop and wait for me.

Step 4 - Install, one mod at a time
- Ask, then add the marketplace from the local clone:
  `claude plugin marketplace add $HOME\src\claude-mods`
- For each mod ask Install / Install disabled / Skip, with its one-line summary
  and your recommendation in the question (one question per mod; up to 4
  questions per prompt is fine). Install with
  `claude plugin install <mod>@my-claude-mods --scope user`.
- Never install reflect-mod (reflect-lite replaces it). Install savvy-progress
  disabled unless I say otherwise (plan-progress and flightdeck cover it).
- hw-write-guard is required: real hardware is attached here. Keep it in `ask`
  mode. Don't offer Skip or Disable for it; if I ask for that anyway, confirm
  first that no hardware is attached to this machine.
- auto-model sends some turns to Haiku or Sonnet instead of my /model pick.
  Recommend skipping it if this account restricts models or isn't on the
  first-party API (Step 1).
- prompt-upgrade (/improve) makes two Sonnet calls each time I use it, and
  cache-tax's keepwarm sends forks while idle: say so in their questions.
- todays-report (/report) only counts locally; nothing leaves the machine.
- After installing plan-progress, offer to turn its sounds off for work
  (`/progress-sounds off`).
- Afterwards, tell me to run /reload-plugins and list what was installed,
  disabled and skipped.

Step 5 - Terminal look (optional, one change at a time)
- Offer each "App look" step from WORK-SETUP.md separately (chat-bubbles
  theme, Tokyo Night Claude Code theme, fullscreen layout, Windows Terminal
  "Claude" profile fragment), plus the Ctrl+V screenshot-paste keybinding from
  "Not in the bundle". For each, show exactly which file changes, back it up,
  merge, and ask first.

Finish with what's installed, every file changed (with backup paths), how to
undo each change, and a reminder that $HOME\src\claude-mods is live: any edit
or `git pull` there changes what runs at the next /reload-plugins, so I should
review before pulling.
```
