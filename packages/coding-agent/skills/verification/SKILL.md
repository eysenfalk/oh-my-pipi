---
name: verification
description: "Evidence-before-claims gate — run verification commands and confirm output before making any success claims, completion assertions, or status reports."
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|---|---|---|
| Tests pass | `bun test` output: 0 failures | Previous run, "should pass" |
| Type check clean | `bun check:ts` output: exit 0 | Partial check, lint passing |
| Lint clean | `bun lint:ts` output: 0 errors | Type check passing |
| Build succeeds | Build command: exit 0 | Lint passing, "looks good" |
| Bug fixed | Test of original symptom: passes | Code changed, assumed fixed |
| Regression test works | RED-GREEN cycle verified | Test passes once |
| Agent completed task | VCS diff shows correct changes | Agent reports "success" |
| Requirements met | Line-by-line checklist against spec | Tests passing |

## Red Flags — STOP

If you catch yourself doing any of these, stop and run verification:

- Using "should", "probably", "seems to", "likely"
- Expressing satisfaction before verification ("Done!", "That should fix it", "All good")
- About to commit, push, or create PR without fresh verification
- Trusting a subagent's success report without checking the diff
- Relying on partial verification ("lint passed so types are fine")
- Thinking "just this once" about skipping verification
- Any wording implying success without having run the command

## Rationalization Prevention

| Excuse | Reality |
|---|---|
| "Should work now" | RUN the verification command |
| "I'm confident" | Confidence is not evidence |
| "Just this once" | No exceptions, ever |
| "Lint passed" | Lint is not type check is not test |
| "Agent said success" | Verify independently with `git diff` |
| "Partial check is enough" | Partial proves nothing about the rest |
| "Different wording, rule doesn't apply" | Spirit over letter — if you're claiming success, verify |
| "Already verified earlier" | Fresh verification means in THIS message |

## Key Verification Patterns

### Tests
```
RUN:    bun test path/to/test.test.ts
CHECK:  Exit code 0, output shows "X pass, 0 fail"
THEN:   "All N tests pass" (with evidence)
```

### Type Check
```
RUN:    bun check:ts
CHECK:  Exit code 0, no error output
THEN:   "Type check passes" (with evidence)
```

### Lint
```
RUN:    bun lint:ts
CHECK:  Exit code 0, no warnings or errors
THEN:   "Lint passes" (with evidence)
```

### Regression Tests (TDD Red-Green)
```
1. Write test --> Run (MUST PASS)
2. Revert the fix --> Run (MUST FAIL)
3. Restore the fix --> Run (MUST PASS)
Only then: "Regression test verified"
```

### Agent Delegation
```
1. Agent reports completion
2. Run `git diff` to verify changes exist and are correct
3. Run project tests to verify nothing broken
4. THEN report actual state (not agent's claim)
```

### Requirements Verification
```
1. Re-read spec/plan
2. Create line-by-line checklist of requirements
3. Verify each requirement independently
4. Report gaps OR confirmed completion
```

## When To Apply

**ALWAYS before:**
- Any variation of success or completion claims
- Any expression of satisfaction about work state
- Committing, pushing, creating PRs
- Marking tasks as completed
- Moving to the next task
- Delegating completion reports to humans
- Creating merge requests or release notes

## Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| **Delayed verification** — "I'll verify at the end" | Errors compound. Verify after each change. |
| **Selective verification** — running only one check | Each check type catches different failures |
| **Cached verification** — "I ran it earlier" | Code changed since then. Run it fresh. |
| **Social verification** — "the agent said it works" | Independent verification only. Check the diff. |
| **Optimistic verification** — running the command but not reading output | Read every line. Exit code is necessary but not sufficient. |

## The Bottom Line

Run the command. Read the output. THEN claim the result.

No shortcuts. No exceptions. Non-negotiable.
