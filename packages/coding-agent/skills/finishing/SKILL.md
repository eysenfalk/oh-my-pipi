---
name: finishing
description: "Complete a development branch — verify tests, present merge/PR/keep/discard options, execute chosen workflow, and cleanup."
---

# Finishing a Development Branch

## Overview

Guide completion of development work by presenting clear options and handling the chosen workflow.

**Core principle:** Verify tests --> Present options --> Execute choice --> Clean up.

## The Process

### Step 1: Verify Tests Pass

Before presenting options, verify tests pass using `skill://verification/SKILL.md`:

```bash
bun test
bun check:ts
```

**If tests fail:**

```
Tests failing (N failures). Must fix before completing:

[Show failures]

Cannot proceed with merge/PR until tests pass.
```

Stop. Do not proceed to Step 2.

**If tests pass:** Show evidence and continue to Step 2.

### Step 2: Determine Base Branch

```bash
# Try common base branches
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

Or ask: "This branch split from main — is that correct?"

### Step 3: Present Options

Present exactly these 4 options:

```
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work

Which option?
```

Do not add explanation — keep options concise.

### Step 4: Execute Choice

#### Option 1: Merge Locally

```bash
git checkout <base-branch>
git pull
git merge <feature-branch>

# Verify tests on merged result
bun test
bun check:ts

# If tests pass
git branch -d <feature-branch>
```

Then: Cleanup worktree (Step 5).

#### Option 2: Push and Create PR

```bash
git push -u origin <feature-branch>

gh pr create --title "<title>" --body "## Summary
- [2-3 bullets of what changed]

## Verification
- [ ] Tests pass
- [ ] Type check passes
- [ ] Lint passes"
```

Then: Report PR URL. Worktree preserved (user may need it for review changes).

#### Option 3: Keep As-Is

Report: "Keeping branch `<name>`. Worktree preserved at `<path>`."

Do not cleanup worktree.

#### Option 4: Discard

**Confirm first:**

```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>
- Worktree at <path>

Type 'discard' to confirm.
```

Wait for exact confirmation.

If confirmed:
```bash
git checkout <base-branch>
git branch -D <feature-branch>
```

Then: Cleanup worktree (Step 5).

### Step 5: Cleanup Worktree

**For Options 1, 2, 4:**

Check if in worktree:
```bash
git worktree list
```

If current directory is a worktree:
```bash
cd <main-repo-path>
git worktree remove <worktree-path>
```

**For Option 3:** Keep worktree.

## Quick Reference

| Option | Merge | Push | Keep Worktree | Cleanup Branch |
|---|---|---|---|---|
| 1. Merge locally | Yes | No | No | Yes |
| 2. Create PR | No | Yes | Yes | No |
| 3. Keep as-is | No | No | Yes | No |
| 4. Discard | No | No | No | Yes (force) |

## Common Mistakes

| Mistake | Fix |
|---|---|
| Skipping test verification | Always verify tests before offering options |
| Open-ended "what should I do?" | Present exactly 4 structured options |
| Auto-cleanup for PR option | Keep worktree — user may need it for review changes |
| No confirmation for discard | Require typed "discard" confirmation |
| Merging without re-testing | Run tests on merged result, not just feature branch |
| Forgetting to pull base branch | Always `git pull` before merge |

## Red Flags

**Never:**
- Proceed with failing tests
- Merge without verifying tests on the merged result
- Delete work without typed confirmation
- Force-push without explicit request
- Auto-select an option — always let the user choose
- Skip worktree cleanup for Options 1 and 4

**Always:**
- Verify tests before offering options (read `skill://verification/SKILL.md`)
- Present exactly 4 options
- Get typed confirmation for Option 4
- Clean up worktree for Options 1 and 4 only
- Report the PR URL for Option 2
