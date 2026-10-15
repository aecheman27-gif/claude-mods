// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash, Monitor): if the command is risky, work out its blast
// radius, open a pane with Proceed and Cancel, and hold the call until one is
// pressed. Anything that goes wrong while holding refuses the call.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision. ($.clock.sleep is only the fallback: its
// wait counts against the 10 s.) On Windows the sleep and the measuring run in
// Git Bash, found by path, since neither `sleep` nor a usable `bash` is on PATH.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

const PANE_ID = "blast-radius";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;

export function register(on) {
  // Modified for my-claude-mods: Monitor's `command` is a shell command too.
  on("tool.call", { tool: ["Bash", "Monitor"] }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) {
      return next(e);
    }
    const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane" };
    let opened = { isPlaced: false };
    let decision;
    let summary = risk.label;
    try {
      // One hold at a time. If another risky call is already held (a subagent's,
      // say), wait until it is answered. `held` is claimed with no await between
      // the check and the claim, so two waiting calls can't both get through.
      // The wait is inside the try, so a wait that fails refuses this call too.
      while (held !== null) {
        if (next.signal.aborted) {
          return { deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
        }
        await pause($);
      }
      held = mine;

      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      mine.report = cwd === null
        ? { summary: `${risk.label} in ${shown(risk.dir)}`, lines: [], note: `Couldn't find the folder ${shown(risk.dir)}, so I couldn't measure what this would change.` }
        : await measure($, risk, cwd);
      summary = mine.report.summary;

      opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine.report) });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await pause($);
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      decision = mine.decision;
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    if (decision === "proceed") {
      $.ui.toast("Blast Radius: running it");
      return next(e);
    }
    const why = {
      cancel: "the user pressed Cancel",
      timeout: "no answer within 10 minutes",
      interrupted: "the turn was interrupted",
      error: "Blast Radius hit an error while holding it",
    }[decision] ?? "no answer was recorded";
    return {
      deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    };
  }).catch(($, e, next) => {
    // Modified for my-claude-mods: fail closed. Without this, a hook that throws
    // or overruns is skipped and the engine runs the command unheld. Asked in
    // the hook's place (a re-entry), it judges the command text alone.
    if (next.error.kind === "re-entry" ? classify(String(e.command ?? "")) === null : next.called) {
      return next(e);
    }
    return { deny: "Blast Radius could not hold this command, so it did not run. Do not retry it unless the user asks you to." };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Modified for my-claude-mods: the other wrappers' options that take a value.
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-S", "--split-string"]); // -C moves the folder
const NICE_VALUE_OPTIONS = new Set(["-n", "--adjustment"]);
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"]);
const XARGS_VALUE_OPTIONS = new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--eof", "--arg-file"]);
// Shells whose -c script is a command line of its own.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);
// Separators between commands: && || ; | newline, and a lone & (not &&, &>, >& or <&).
const SEPARATORS = /&&|\|\||;|\||\n|(?<![<>&])&(?!>)/;
// Stands in a command line for a $( ), <( ), >( ) or `...` that is read on its own.
const SUB = "\u0001";

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(arg)) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** Text for the pane, with each lifted substitution shown as $(…). */
function shown(text) {
  return String(text).split(SUB).join("$(…)");
}

/**
 * The command line with each $( ), <( ), >( ) and `...` replaced by SUB, and
 * the commands inside them in order. They run before the command around them.
 */
function lift(command) {
  const inner = [];
  let outer = "";
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if ((c === "$" || c === "<" || c === ">") && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j += 1) {
        if (command[j] === "(") {
          depth += 1;
        } else if (command[j] === ")") {
          depth -= 1;
        }
      }
      inner.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
      outer += SUB;
      i = j - 1;
    } else if (c === "`") {
      const end = command.indexOf("`", i + 1);
      const stop = end === -1 ? command.length : end;
      inner.push(command.slice(i + 1, stop));
      outer += SUB;
      i = stop;
    } else {
      outer += c;
    }
  }
  return { outer, inner };
}

/** The first risky segment of a shell command, or null. `start` is where the line starts (null = the session folder). */
function classify(command, start = null) {
  const { outer, inner } = lift(command);
  let dir = start; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  let lifted = 0; // how many of `inner` have been read
  for (const raw of outer.split(SEPARATORS)) {
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = (tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    // A $( ) or `...` in this segment runs first, in the same folder.
    for (let n = raw.split(SUB).length - 1; n > 0; n -= 1) {
      const risk = classify(inner[lifted], dir);
      lifted += 1;
      if (risk !== null) {
        return risk;
      }
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return risk;
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop(); // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "nohup", "time", "then", "do", "else", "!"]);

/** Drops leading options, and the value after each one in `takesValue`; stops after `--`. */
function dropOptions(words, takesValue) {
  while (words.length > 0 && words[0].startsWith("-") && words[0] !== "-") {
    const option = words.shift();
    if (option === "--") {
      break;
    }
    if (takesValue.has(option)) {
      words.shift();
    }
  }
}

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment, dir, pushed) {
  {
    const words = tokenize(segment.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
    // Modified for my-claude-mods: wrappers in any order and number (VAR=value,
    // sudo, env, nice, timeout, nohup, xargs) are stripped down to the command
    // they run. xargs hands that command paths from its input.
    let fromInput = false;
    for (;;) {
      const word = (words[0] ?? "").replace(/^\\/, "");
      const base = word.slice(word.lastIndexOf("/") + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PREFIXES.has(word)) {
        words.shift(); // leading VAR=value, or a word that changes nothing
      } else if (base === "sudo") {
        words.shift();
        dropOptions(words, SUDO_VALUE_OPTIONS);
      } else if (base === "env") {
        words.shift();
        while (words.length > 0 && words[0].startsWith("-") && words[0] !== "-") {
          const option = words.shift();
          if (option === "--") {
            break;
          }
          if (option === "-C" || option === "--chdir") {
            dir = joinDir(dir, words.shift());
          } else if (ENV_VALUE_OPTIONS.has(option)) {
            words.shift();
          }
        }
      } else if (base === "nice") {
        words.shift();
        dropOptions(words, NICE_VALUE_OPTIONS);
      } else if (base === "timeout") {
        words.shift();
        dropOptions(words, TIMEOUT_VALUE_OPTIONS);
        words.shift(); // the duration
      } else if (base === "xargs") {
        words.shift();
        dropOptions(words, XARGS_VALUE_OPTIONS);
        fromInput = true;
      } else {
        break;
      }
    }
    const [first, ...args] = words;
    if (first === undefined) {
      return null;
    }
    const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
    const base = cmd.slice(cmd.lastIndexOf("/") + 1);
    if (SHELLS.has(base)) {
      // bash -c "script", sh -c '...': read the script as a command line.
      const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      if (at !== -1 && args[at + 1] !== undefined) {
        return classify(args[at + 1], dir);
      }
    }
    if (base === "eval") {
      return classify(args.join(" "), dir);
    }
    if (base === "find") {
      // find -delete and find -exec rm delete what find matches as it runs.
      const exec = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
      const execRm = exec !== -1 && /(^|\/)rm$/.test((args[exec + 1] ?? "").replace(/^\\/, ""));
      if (args.includes("-delete") || execRm) {
        return { kind: "find", label: args.includes("-delete") ? "find -delete" : "find -exec rm", dir, unmeasured: "find chooses the files as it runs" };
      }
    }
    if (cmd === "cd") {
      return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
    }
    if (cmd === "pushd") {
      pushed.push(dir);
      return { cd: joinDir(dir, args[0]) };
    }
    if (cmd === "popd") {
      return { cd: pushed.length > 0 ? pushed.pop() : "-" };
    }
    if (cmd === "rm" || cmd.endsWith("/rm")) {
      const flags = args.filter((a) => a.startsWith("-"));
      const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
      const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
      if (recursive || force) {
        const targets = args.filter((a) => !a.startsWith("-") || a === "-");
        if (fromInput) {
          return { kind: "rm", label: `xargs rm ${flags.join(" ")}`.trim(), targets: [], dir, unmeasured: "xargs passes rm the paths from its input" };
        }
        return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
      }
    }
    if (cmd === "git") {
      // Git's own options come before the subcommand; -C moves where it runs.
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        if (args[i] === "-C" && i + 1 < args.length) {
          gitDir = joinDir(gitDir, args[i + 1]);
          i += 2;
        } else if (args[i] === "-c" && i + 1 < args.length) {
          i += 2;
        } else {
          i += 1;
        }
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (sub === "reset" && rest.includes("--hard")) {
        return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
      }
      if (sub === "clean") {
        return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
      }
      // -f alone or in a bundle (-fu); the letters after an o are -o's value.
      const forces = (a) => a === "--force" || (/^-[^-]/.test(a) && a.slice(1).split("o")[0].includes("f")) || a.startsWith("--force-with-lease") || /^\+/.test(a);
      if (sub === "push" && rest.some(forces)) {
        return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
      }
      const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
      if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !stagedOnly) {
        return { kind: "git-checkout", label: `git ${sub} -- .`, args: rest, dir: gitDir };
      }
    }
    const joined = words.join(" ");
    if (/\balembic\s+upgrade\b/.test(joined)) {
      return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
    }
    if (/\bdb:migrate(?!:status\b)/.test(joined)) {
      return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
    }
    if (/\bprisma\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
    }
    if (/\bmanage\.py\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
    }
    if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
      return { kind: "migrate", tool: "unknown", label: "migrate", dir };
    }
  }
  return null;
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source. Git Bash's cygpath
// turns /c/... into C:/..., a folder Windows can start a process in.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && { cygpath -m "$(pwd -P)" 2>/dev/null || pwd -P; }`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const bash = await findBash($);
  if (bash === null) {
    return null;
  }
  const run = await $.process.run([bash, "-c", CD_SCRIPT, "blast-radius", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

// Modified for my-claude-mods: on Windows the first bash on PATH is usually
// WSL's (C:\Windows\System32\bash.exe), where C:/ and /c/ paths don't exist, so
// it measured "nothing to delete". Measure in Git Bash, found by path. `bash`
// elsewhere; null on Windows with no Git Bash found.
let bashPath;

async function findBash($) {
  if (bashPath === undefined) {
    bashPath = await lookUpBash($);
  }
  return bashPath;
}

async function lookUpBash($) {
  if ((await $.env.get("OS")) !== "Windows_NT") {
    return "bash";
  }
  const set = await $.env.get("CLAUDE_CODE_GIT_BASH_PATH");
  if (set && (await $.fs.exists(set))) {
    return set;
  }
  const programFiles = await $.env.get("ProgramFiles");
  if (programFiles && (await $.fs.exists(`${programFiles}\\Git\\bin\\bash.exe`))) {
    return `${programFiles}\\Git\\bin\\bash.exe`;
  }
  // Elsewhere, from the git on PATH: its exec path is <Git>/mingw64/libexec/git-core.
  const git = await $.process.run(["git", "--exec-path"], { timeoutMs: 5000 }).catch(() => null);
  const root = git?.exitCode === 0 ? git.stdout.trim().replace(/[\\/][^\\/]+[\\/]libexec[\\/]git-core$/i, "") : "";
  return root && (await $.fs.exists(`${root}/bin/bash.exe`)) ? `${root}/bin/bash.exe` : null;
}

/** One poll of a hold: a `$` call, so the wait doesn't spend the hook's own 10 s. */
async function pause($) {
  const bash = await findBash($);
  if (bash === null) {
    // Windows with no Git Bash: a clock wait does spend the 10 s, so an
    // unanswered hold ends (refused) after about that, rather than at once.
    await $.clock.sleep(Number(POLL_SECONDS) * 1000);
    return;
  }
  await $.process.run(bash === "bash" ? ["sleep", POLL_SECONDS] : [bash, "-c", `sleep ${POLL_SECONDS}`], { timeoutMs: 5000 });
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- Measuring the blast radius -------------------------------------------

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
async function measure($, risk, cwd) {
  try {
    if (risk.unmeasured) {
      return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${risk.unmeasured}.` };
    }
    if (risk.kind === "rm") {
      return await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return await measureMigrations($, risk, cwd);
    }
    return await measureGit($, risk, cwd);
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*|[A-Za-z]:*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($, risk, cwd) {
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], note: "No paths to expand." };
  }
  // Modified for my-claude-mods: a path from $VAR, $( ) or `...` is known only
  // when the shell runs, so it isn't measured as the literal text.
  if (risk.targets.some((t) => t.includes("$") || t.includes(SUB))) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: "Could not measure: a path comes from a variable or a command's output, which only the shell knows." };
  }
  const bash = await findBash($);
  if (bash === null) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: "Could not measure: Git Bash was not found. Set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe." };
  }
  const run = await $.process.run([bash, "-c", RM_SCRIPT, "blast-radius", ...risk.targets], { cwd, timeoutMs: 15000 });
  const [head, ...rest] = run.stdout.split(/\r?\n/).filter((l) => l !== "");
  // Modified for my-claude-mods: only a clean "files bytes paths" line is a
  // measurement. A bash that failed, or printed an error, must not read as
  // "delete nothing".
  if (run.exitCode !== 0 || !/^\d+ \d+ \d+$/.test(head ?? "")) {
    const why = run.stderr.trim() || head || `bash exited with ${run.exitCode}`;
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${why.slice(0, 200)}` };
  }
  const [files, bytes, found] = head.split(" ").map(Number);
  if (!found) {
    return { summary: `delete nothing: no file matches ${risk.targets.join(" ")}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." };
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${risk.targets.join(" ")}` };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${risk.targets.join(" ")}`,
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
    return {
      summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch) {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

// Modified for my-claude-mods: the listers above run the project's own code
// (manage.py, bin/rails, alembic's env.py, node_modules' prisma), and this hook
// runs before the permission check, so a hold could execute repository code the
// person or auto mode would then refuse. The hold now names the command without
// listing; ALLOW_PROJECT_LISTERS stays false.
const ALLOW_PROJECT_LISTERS = false;

async function measureMigrations($, risk, cwd) {
  if (!ALLOW_PROJECT_LISTERS) {
    return { summary: `run ${risk.label}`, lines: [], note: "Pending migrations are not listed: listing them would run the project's own code before you decide." };
  }
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report) {
  return Math.min(24, 9 + report.lines.length + (report.more ? 1 : 0));
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report } = state;
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: `  + ${report.more} more` }));
  }
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: "yellow", children: `⚠ Blast Radius · ${state.risk.label}` }),
      Text({ key: "cmd", children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command })], wrap: "truncate-end" }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })] }),
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, children: "Claude is waiting on your answer" }),
        ],
      }),
    ],
  });
}
