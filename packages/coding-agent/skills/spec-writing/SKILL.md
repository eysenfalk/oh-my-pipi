---
name: spec-writing
description: "Write formal requirements specifications with RFC 2119 keywords, acceptance criteria, and delta specs for brownfield changes."
---

# Writing Specifications

## Overview

A specification defines **what** the system must do, not how. It reduces ambiguity, enables verification, and serves as acceptance criteria. Every requirement maps to a testable assertion. If you can't test it, rewrite it.

## When to Use

- Medium+ features (3+ files)
- Any work with unclear or contested requirements
- Anything that will be reviewed by humans or implemented by subagents
- When the brainstorming phase produced a design doc that needs formal requirements

## Specification Format

```markdown
# [Feature] Specification

## Purpose
[One paragraph describing what this feature does and why it exists.]

## Requirements

### Functional
- The system SHALL [requirement]. (RFC 2119)
- The system MUST [requirement].
- The system SHOULD [recommendation].
- The system MAY [optional behavior].

### Non-Functional
- The system SHALL respond within [N]ms for [operation].
- The system MUST handle [N] concurrent [operations].

## Acceptance Criteria
- WHEN [condition] THEN [expected result].
- WHEN [condition] AND [condition] THEN [expected result].
- WHEN [error condition] THEN [error behavior].

## Non-Goals
- [What this spec explicitly does NOT cover.]
- [Adjacent features that are out of scope.]

## Open Questions
- [Unresolved decisions that need human input before implementation.]
```

## Delta Specification Format

For changes to existing systems. Use when modifying, not building from scratch.

```markdown
# [Feature] Delta Specification

## Purpose
[What is changing and why.]

## Baseline
[Reference to existing behavior being modified.]

### ADDED
- [New component]: [responsibility]
- [New behavior]: WHEN [condition] THEN [new result]

### MODIFIED
- [Component]: [before] --> [after]
- [Behavior]: WHEN [condition] THEN [old result] --> [new result]

### REMOVED
- [Component]: [migration path or justification]
- [Behavior]: [what replaces it]

## Acceptance Criteria
[Same WHEN/THEN format as above, covering all ADDED and MODIFIED items.]

## Non-Goals
[What is NOT changing, especially if adjacent to what IS changing.]
```

## RFC 2119 Keyword Usage

| Keyword | Meaning | Use When |
|---|---|---|
| **MUST** / **SHALL** | Absolute requirement | Violation = system failure |
| **MUST NOT** / **SHALL NOT** | Absolute prohibition | Violation = system failure |
| **SHOULD** | Recommended, but valid reasons to ignore exist | Default behavior, can be overridden |
| **SHOULD NOT** | Discouraged, but valid reasons to include exist | Anti-pattern with escape hatch |
| **MAY** | Truly optional | Nice-to-have, not required for acceptance |

**Rules:**
- One requirement per bullet point
- Every MUST/SHALL maps to at least one acceptance criterion
- Every SHOULD has a rationale (why recommended, not required?)
- MAY items do NOT get acceptance criteria (they're optional)

## Writing Testable Requirements

| Bad (untestable) | Good (testable) |
|---|---|
| "The system should be fast" | "The system SHALL respond within 200ms for search queries under 100 results" |
| "The UI should be user-friendly" | "The system SHALL display validation errors inline within 100ms of field blur" |
| "Improve error handling" | "The system SHALL return structured errors with code, message, and path fields" |
| "Support large files" | "The system SHALL process files up to 50MB without exceeding 512MB memory" |

**Test:** For each requirement, can you write a WHEN/THEN acceptance criterion? If not, the requirement is too vague.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Vague requirements ("improve performance") | Quantify: "respond within Nms for X" |
| Untestable criteria ("user-friendly") | Observable behavior: "display error within Nms" |
| Missing non-goals | Explicitly list what's out of scope |
| Scope creep in spec | Move new ideas to a separate spec or non-goals |
| Implementation details in spec | Describe behavior, not mechanism |
| Missing error cases | Add WHEN [error] THEN [behavior] for each error path |
| Ambiguous pronouns ("it should handle this") | Name the component and the input explicitly |

## Review Process

After writing the spec:

1. Dispatch `critic` agent with the spec file path and original requirements
2. Critic checks: testable requirements? Complete acceptance criteria? Missing error cases? Scope creep?
3. If issues found: fix and re-dispatch (max 3 iterations)
4. If approved: present to user for final review
5. User approves: proceed to next phase (design or planning)

## Artifact Location

Write the spec to `docs/workflow/<slug>/spec.md` where `<slug>` follows the convention `YYYY-MM-DD-<topic>`.

## Pre-Implementation Checklist

Before handing off to planning:

- [ ] Every MUST/SHALL has a matching acceptance criterion
- [ ] Every acceptance criterion is WHEN/THEN format
- [ ] Non-goals explicitly listed
- [ ] Error cases covered
- [ ] No implementation details in requirements
- [ ] Open questions resolved or flagged for human input
- [ ] Critic review passed
- [ ] User approved
