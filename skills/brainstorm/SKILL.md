---
name: brainstorm
description: Plan a task with the user before building it. Research the project, ask rounds of questions, write a spec to .task/<name>.md that describes every part in the same detail, wait for the user's go-ahead, then carry out the spec's plan. Use when the user asks to brainstorm, plan, scope or spec out a task, feature, tool or project before building it ("let's brainstorm X", "plan this out", "write a spec for X", "/brainstorm X"). Not for small, clear requests that can just be done.
---

# Brainstorm

This skill turns a task into a spec that the user approves before any of it gets built. The spec lives in `.task/<name>.md` in the current working directory. Every part of the task is described at the same depth, so no part is left for the builder to guess at. The numbered sections below run in order.

## Autonomous mode and unanswered questions

- The question rounds, the continue-or-new question and the review gate run even when autonomous mode is on. Autonomous mode applies to the work that follows the go.
- These questions wait for an answer. Don't ask them in plain text and carry on with a default, as `session-kit:start` suggests for other questions.
- If a question round goes unanswered (the dialog closes by itself with a note that the user may be away), take that round's defaults and mark them `default (unanswered)` in the Decisions log. Ask no more question rounds: finish the spec and the density check from research, and still stop at the review gate. If the user comes back and replies, question rounds can resume.
- For this skill's own questions, the rule above replaces the `session-kit:start` skill's standing rule about unanswered questions (take the recommended option, turn autonomous mode on, ask nothing more). An unanswered brainstorm question doesn't turn autonomous mode on, and the review gate is still asked.
- If the user says to skip the questions, take the defaults for whatever is still open, mark them `default (skipped)`, and still stop at the review gate.
- If `AskUserQuestion` isn't available (in a subagent or in print mode), treat every round as unanswered. Write the spec from research and defaults, run the density check, then stop with the spec's path and build nothing.
- Nothing gets built without an explicit go from the user. An unanswered question is never a go.

## Where specs live

- One file per task, `.task/<name>.md`, where `<name>` is a short kebab-case name for the task, such as `csv-export` or `login-rate-limit`.
- Create the folder if it's missing, and keep it out of git the same way `session-kit:create-context` keeps `.agentcontext` out. Create the folder before the check: `git check-ignore` matches a folder rule only once the folder exists.

  ```bash
  mkdir -p .task
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git check-ignore -q .task; then
    ex=$(git rev-parse --git-path info/exclude)
    mkdir -p "$(dirname "$ex")" && printf '.task/\n' >> "$ex"
  fi
  ```

  If it added the rule, say so in one line: the exclude file is private to this clone, and the user can list `.task/` in `.gitignore` instead to share the rule.
- If `.task/<name>.md` already exists, ask with `AskUserQuestion` whether to continue it or start a new one: "Continue it (Default)" or "Start a new one". A new one gets its own name, such as `<name>-2.md`; never overwrite the old file. If the question goes unanswered, continue the existing spec and treat it as an unanswered round. A continued spec picks up where its status says:
  - `drafting`: carry on with research and question rounds.
  - `awaiting go-ahead`: go to the review gate.
  - `approved` or `in progress`: the go was given earlier. Resume the plan at the first unticked step.
  - `done`: the user wants more on a finished task. Set the status back to `drafting`, add the new work as new parts and plan steps, and run the steps below on them.

## 1. Understand and research

- Restate the task in one or two lines, and give the spec's path.
- Before asking anything, read what already answers questions: the code the task touches, the README and other docs, the `.agentcontext` files in this folder and its parents, and the other specs in `.task/`. No question should ask something the repo already answers.
- Write what you found in the spec's Context section: the existing code and how it works now, constraints, conventions to follow, related specs. Give file paths.
- In a multi-agent session the coordinator runs this skill itself up to the go. Reading files, asking the questions and writing the spec are planning work.

## 2. Split the task and draft the spec

- Split the task into parts that suit it: components, features, screens or steps. Each part should be something you can describe on its own and check on its own.
- Copy the template from this skill's folder, then fill it in:

  ```bash
  cp -n "${CLAUDE_SKILL_DIR}/spec-template.md" .task/<name>.md
  ```

- Set Created and Updated to today's date, and change Updated on every later edit.
- Fill in every section you can from the request and the research. Where you don't know an answer yet, write `Open: <what's missing>`, so the question rounds and the density check can find it.

## 3. Question rounds

Ask the user about the details of each part and about how it should be achieved: the approach, tools and libraries, layout, edge cases, error handling, what "done" means, and testing.

- Use `AskUserQuestion`, with up to 4 questions per call and 2 to 4 options per question. The first option is the default, picked from research and the project's conventions, and its label ends in " (Default)". Don't mark options "(Recommended)", and don't add an "Other" option: the dialog has its own free-text answer.
- Give each question a header of at most 12 characters naming the part it's about, such as `Export` or `Search 2`.
- Spread each round across parts. Take questions from the thinnest cells of the density grid (step 4), so the thin parts get asked about, not just the most interesting one.
- Keep asking until every part passes the density check. A real task usually takes several rounds. Follow-up questions on an answer are fine.
- Don't ask what the code already answers, or about choices with only one sensible answer. Record those as `default` and move on.
- Record every answer in the spec right away, in the part it affects and as a row in the Decisions log. Quote typed answers as written. Mark where each one came from:
  - `user`: the user picked an option (the default included) or typed an answer.
  - `default`: your own call, made without asking, because research settled it or it was too minor to ask.
  - `default (unanswered)` or `default (skipped)`: see "Autonomous mode and unanswered questions".

## 4. Detail density check

Every part covers the same five facets, each under its own heading in the spec:

1. What it does.
2. Inputs and outputs.
3. Behavior and edge cases, errors included.
4. How it's built: the approach, and the files or modules it touches.
5. How it's verified: acceptance criteria and tests.

Each facet needs concrete specifics (names, values, numbers, file paths), not generalities. To check:

1. Make a grid with a row per part and a column per facet. In each cell, write two counts as specifics/vague:
   - A concrete specific is something a builder can act on without asking: a file path, a function or field name, a command, a value, a limit, a named edge case and what happens in it, a named test or acceptance check.
   - A vague line is one they'd have to ask about, such as "handles errors", "fast enough", "standard layout", "add tests" or "etc.". Every `Open:` line counts as vague.
2. A part passes when every cell has at least one specific and no vague lines, and its total of specifics is at least half that of the most detailed part. A part may fall below half only when its scope is plainly smaller, and its cells still have to pass.
3. Fix a failing part from research first, and ask a question round for what research can't settle. Don't even out the parts by cutting detail from the dense ones.

For example:

```text
Part           What  I/O  Behavior  Built  Verified  Total
Search box     3/0   4/0  5/0       3/0    4/0       19
Results list   2/0   3/0  1/1       2/0    0/0        8
```

The results list fails three ways: its behavior cell has a vague line, nothing says how it's verified, and its 8 specifics are under half of the search box's 19.

- An `Open:` line can't stay in a part. If something truly can't be settled before building, for example because it depends on a measurement taken during the work, move it to Risks and open questions with what will settle it.
- The Plan needs specifics too: every step names the files it touches and the check that makes it done.
- Run the check before the review gate, and again after any edit to the spec.

## 5. Review gate

1. Set the status to `awaiting go-ahead`.
2. Ask with `AskUserQuestion` how the user wants to review the spec (header `Review`). Don't mark either option as the default, since the review is the user's choice:
   - **Read the full spec**: they open `.task/<name>.md` and read it.
   - **Simplified version**: you write a short, plain-language summary in chat.
3. For the full spec, give its path. For the simplified version, write the summary with the spec's structure: what gets built, the parts, the approach and the plan steps, a line or two each, short enough to read in a minute. It never replaces the spec file.
4. In the same message, ask for the go-ahead with `AskUserQuestion` (header `Go-ahead`), with no default: **Go** or **Change something**. The dialog waits while they read.
5. On a change (ask what to change if they didn't say), update the spec, log the change in the Decisions log, redo the density check, say in a few lines what changed, and ask for the go-ahead again.

Only an explicit go starts the work: the user picks Go, or says so in their own words ("go", "build it", "approved"). Silence, an unanswered dialog or praise for one part isn't a go. If a review question goes unanswered, write the simplified version in chat, say that the spec at `.task/<name>.md` is waiting for a go, and end the turn without building anything.

## 6. Execute on go

1. Set the status to `approved`, then to `in progress` when the first plan step starts.
2. Carry out the Plan step by step, in the session's workflow, which `session-kit:start` sets (the `workflow` field in the session's state file):
   - **Single-agent**: do the steps yourself.
   - **Multi-agent**: turn plan steps into agent briefs. Give each agent the spec's absolute path, since `.task/` is kept out of git and won't be in its worktree, and name the plan steps it owns. Agents read the spec but don't edit it. They report anything that departs from it, and you record that.
3. Tick a step's checkbox when its "Done when" check holds, and keep the status and the Updated date current as work lands. At the end, set the status to `done` and report what was built against the Goal.
4. If the work has to depart from the spec, record what changed and why in "Changes during execution". Ask the user first only when the change alters the scope or a decision the user made. With autonomous mode on, make the call that stays closest to the spec, record it, and include it in the "Decisions I made" list.
