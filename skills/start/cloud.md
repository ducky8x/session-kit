# Cloud agents

This file is part of the `session-kit:start` skill. Read it in a multi-agent session when `cloud.on` is true in the state file, before the first dispatch. SKILL.md has the state file and the coordinator rules these steps build on.

With cloud on, every worker task that doesn't need the user's Mac goes to a cloud subagent: the Agent tool with `isolation: "remote"`. Its commits come back on a pushed task branch, and large files come back through a draft GitHub release. Until Claude Code runs these subagents in the cloud, the first cloud task of each session finds that out, and the rest of the session runs locally.

Cloud mode allows these pushes without asking: task branches (pushed before the dispatch, deleted after the merge) and draft releases for large outputs. Never push `main`. Any other push still waits for the user.

## Routing

Decide for each worker task: the cloud or this Mac. Say the choice in the dispatch line to the user, for example "Dispatched fix/parser-crash (cloud)".

A task goes to the cloud when all of these hold:

- `workflow` is `multi`;
- `cloud.on` is true;
- `cloud.remote` isn't `"unavailable"`;
- the task doesn't need the Mac. Length doesn't matter.

A task needs the Mac when it does any of these:

1. Runs macOS-only tools: `xcodebuild`, `swift` with `DEVELOPER_DIR`, `codesign`, `notarytool`, `osascript`, `launchctl`, `security`, `open`, `defaults`, `screencapture`.
2. Builds, launches or tests a macOS or iOS app, or uses the iOS Simulator.
3. Reads or writes anything outside the repo, such as `~/.claude`, `~/Movies` or `~/Downloads`, or the user's real data, settings or apps.
4. Needs work that can't be pushed: the repo has no GitHub remote, or the user said not to push this work.
5. Needs the screen, a browser pane, computer use, hardware, or a local server the user watches.
6. Needs secrets kept on the Mac, such as the Keychain or a `.env` file that isn't in git.
7. Runs one command longer than about 9 minutes that can't save checkpoints and resume.
8. Would produce a single output file over 2 GB, the release asset limit.

Unsure: local.

Examples that go to the cloud:

- research;
- code changes with tests that run on Linux;
- docs and wording passes;
- training that can save checkpoints.

Examples that stay local:

- builds of a macOS app;
- anything under `~/.claude`;
- checks of session-kit's Discord helper;
- signing.

Cloud tasks and local tasks can run side by side. The rule against two agents on the same files still holds.

## Dispatch

Set up and push the task branch first (see "Task branches"). Then call the Agent tool with `isolation: "remote"` and `run_in_background: true`, and leave out `model` and `effort`. The brief is a normal standalone brief with the cloud brief block (at the end of this file) pasted in.

The block has the agent run `printf 'CLOUD_CHECK=%s\n' "${CLAUDE_CODE_REMOTE:-unset}"` as its first command, and the report's first line has to be `CLOUD_CHECK=<value>`. That line shows whether the task really ran in the cloud. Save what it shows in `cloud.remote` with the same read-modify-write as for the rest of the state file: read the file, change only `cloud.remote` and `updatedAt`, and write the whole object back.

1. **`remote` is `"unknown"` or `"available"`:** dispatch with `isolation: "remote"`.
2. **The report says `CLOUD_CHECK=true`:** set `remote` to `"available"`, and handle the result as in "Task branches" (the cloud case).
3. **The report says anything else** (`unset`, empty or `false`): the task ran on the Mac.
   - Set `remote` to `"unavailable"`.
   - Say once, at the keyboard and with a Discord post if Discord is on: "Cloud subagents aren't available on this account yet, so cloud tasks run on this Mac for this session."
   - The work is still valid: merge it as a local branch ("Task branches", the local case).
   - Dispatch every later task as a normal local agent, with a branch and worktree that follow the user's rules.
4. **The report has no `CLOUD_CHECK` line:** ask the agent once with `SendMessage` to run the command and reply with the line. If it still doesn't, treat that as unavailable.
5. **The Agent call fails** because remote isolation isn't accepted: treat that as unavailable, as in step 3, and dispatch the same brief locally right away, in a worktree for the task branch (see "Task branches").
6. **A cloud agent stops partway** (the VM was reclaimed, a usage limit, a crash): resume it with `SendMessage`, as `session-kit:autonomous-mode` does for any stopped agent. If that fails, start a fresh remote agent. Its brief says the branch already holds the commits pushed so far.
7. **The fallback's harness worktree:** a task that ran on the Mac worked in `.claude/worktrees/agent-<id>`, on a branch `worktree-agent-<id>`. After the merge, remove the worktree with `git worktree remove .claude/worktrees/agent-<id>`, and delete a leftover `worktree-agent-<id>` branch that has no unmerged commits with `git branch -d worktree-agent-<id>`.
8. **Next session:** the check runs again on its first cloud task.

## Task branches

Each cloud task gets its own branch, `<prefix>/<name>` with one of the user's prefixes (feat/, fix/, debug/, smoke/, docs/, chore/), created from `main`.

- **Pushes you make:** `git push -u origin <branch>` before the dispatch, and `git push origin --delete <branch>` after the merge. Never `main`.
- **Pushes the cloud agent makes:** `git push origin <branch>` after each commit, and only when `CLOUD_CHECK=true`.

1. **Before dispatch:**
   - Create the branch from `main` with `git branch <branch> main`. Don't give it a worktree yet. Git won't check out a branch that another worktree holds, so a worktree on it would block the agent's `git checkout -B` in a fallback and your `git branch -f` after a cloud run.
   - Scan `git log origin/main..<branch>` and `git diff origin/main...<branch>` for trailers, AI names, `/Users/` paths and the user's real name, and fix anything that turns up.
   - Then push the branch with `git push -u origin <branch>`.
   - If `main` has unpushed commits, they go up on the task branch only.
2. **The brief tells the agent to** (the cloud brief block covers all three):
   - start from the task branch: `git fetch origin <branch> && git checkout -B <branch> origin/<branch>`;
   - commit after each step, and push after each commit when in the cloud;
   - never push another branch, never merge, never touch `main`.
3. **When the report arrives (cloud case):**
   - `git fetch origin <branch>`, then `git branch -f <branch> origin/<branch>`.
   - Review `git log main..<branch>` and `git diff main...<branch>`, as for any agent.
   - `git merge --no-ff -m "Merge branch '<branch>'" <branch>`, then the full test run.
   - `git push origin --delete <branch>`. The local branch label stays.
4. **Local case:** the agent's commits are on `<branch>` in the shared repo. Merge them the same way; there's nothing to fetch. If you pushed the branch before the dispatch (the task that found cloud subagents unavailable, or a task rerun after a refused push), delete it after the merge with `git push origin --delete <branch>`. Otherwise there's nothing to delete remotely.
5. **A task branch that runs locally after all** (the Agent call failed, or a push was refused): give it a worktree first, where the user's rules put worktrees, for example `git worktree add ../<repo>-worktrees/<name> <branch>`, and name that worktree in the brief.
6. **A push is refused in the cloud** (a private repo without the GitHub App): the agent stops and reports it. Set `remote` to `"unavailable"` for this session, with the notice "Cloud subagents can't push to this repo, so cloud tasks run on this Mac for this session.", and rerun the task locally from the same branch.
7. **The remote task branch was deleted by hand** before the merge: say so and ask the user whether to rerun. Never recreate the branch on your own.
8. **Text on GitHub** (release titles, release notes, branch names) follows the user's rules: no assistant names, plain words.

## Long commands

A cloud VM runs a foreground command for up to 10 minutes and pauses after a few minutes without activity. So a command expected to run over 9 minutes goes to the cloud only if it can save checkpoints and resume. The brief then says to:

- run it in chunks in the foreground with `timeout 540`, resuming from the last checkpoint each time, until it reports done;
- commit small outputs (metrics, logs) after each chunk.

Foreground chunks keep the VM active, so it doesn't pause. If the job can't checkpoint, the task stays local ("Routing", rule 7).

## Large outputs

Files of 50 MB or less are committed. Any file over 50 MB goes to a draft release instead. A task whose single output file would be over 2 GB, the release asset limit, stays local ("Routing", rule 8).

- **Tag:** `artifacts-<slug>`, where the slug is the branch with `/` turned into `-`. For `feat/train-model` the tag is `artifacts-feat-train-model`.
- **Title:** `artifacts <branch>`.
- **Notes:** one line saying what the files are.
- **Where downloads land:** the folder the brief names. It has to be ignored by git, for example `checkpoints/` in a training repo. Check it with `git check-ignore -q <dir>` before the dispatch.

1. The agent runs `gh release create artifacts-<slug> --draft --title "artifacts <branch>" --notes "<line>" <files>`, or `gh release upload artifacts-<slug> <files> --clobber` when the release already exists. Its report lists each asset's name, size and SHA-256.
2. You run `gh release download artifacts-<slug> --dir <dest>` and check each SHA-256 against the report (`shasum -a 256 <dest>/<file>`). If a hash doesn't match, keep the release and tell the user.
3. When every hash matches, run `gh release delete artifacts-<slug> --yes`. Leave out `--cleanup-tag`: a draft release never creates its tag, so that flag fails with HTTP 422. To confirm no tag is left, `gh api repos/<owner>/<repo>/git/matching-refs/tags/artifacts --jq length` prints 0.
4. If the upload fails (no `gh`, no auth, a 403 from the proxy), the agent stops and reports it, and you rerun that step locally.

## Cloud brief block

Paste this into every cloud brief, with `<branch>` and `<slug>` filled in. Keep all of it, even when the task has no long command or large output.

```text
Cloud task rules (mandatory):

1. Run this as your first command, before anything else:
     printf 'CLOUD_CHECK=%s\n' "${CLAUDE_CODE_REMOTE:-unset}"
   The first line of your final report must be the line it printed, exactly.
2. Start from the task branch:
     git fetch origin <branch> && git checkout -B <branch> origin/<branch>
3. Commit after each step. If CLOUD_CHECK printed true, push after each
   commit with `git push origin <branch>`; otherwise don't push. Never push
   another branch, never merge, never touch main. If a push is refused, stop
   and report it.
4. A command expected to run over 9 minutes runs in chunks in the foreground
   with `timeout 540 <command>`, resuming from the last checkpoint each time,
   until it reports done. Commit small outputs (metrics, logs) after each
   chunk. If the command can't resume from a checkpoint, stop and report that.
5. Commit files of 50 MB or less. Never commit a file over 50 MB; list them with
     find . -path ./.git -prune -o -type f -size +50M -print
   and upload them to a draft release instead:
     gh release create artifacts-<slug> --draft --title "artifacts <branch>" --notes "<one line saying what the files are>" <files>
   or, when the release already exists:
     gh release upload artifacts-<slug> <files> --clobber
   List each asset's name, size and SHA-256 in your report. If the upload
   fails (no gh, no auth, a 403 from the proxy), stop and report it.
6. Release titles, release notes and branch names use plain words and no
   assistant names.
```
