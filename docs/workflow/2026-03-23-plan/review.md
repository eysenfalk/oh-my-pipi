# Review: Workflow Config Redesign

## Requirements Coverage

| Requirement | Covered | Notes |
|---|---|---|
| Remove `/plan` command | Yes | Section 3 |
| Remove `/auto` command | Yes | Section 3 |
| Remove plan-mode sub-stages | Yes | Section 4, autoMode also removed |
| `/workflow config` opens TUI | Yes | Section 2, dedicated component |
| Per-phase enabled toggle | Yes | Section 1 |
| Per-phase approval (none/user/agent/both) | Yes | Section 1 |
| Per-phase reviewAgent (critic/reviewer) | Yes | Section 1 |
| Per-phase maxReviewRounds (1-5) | Yes | Section 1 |
| Global vs session scope toggle (`g`) | Yes | Section 2 |
| `*` marker for session overrides | Yes | Section 2 |
| All phases write to `local://` first | Yes | Section 5 |
| Persist to `docs/workflow/<slug>/` on approval only | Yes | Section 5, clarified in latest revision |
| Every phase writes learnings | Yes | Section 5 |
| Execution phases write repo-wide docs | Yes | Section 5 |

All requirements covered. No gaps.

## Edge Cases Reviewed

1. **All phases disabled**: `#getNextPhase` must skip disabled phases. If all are disabled, workflow completes immediately.
2. **Mid-workflow setting change**: User changes approval from "user" to "none" mid-workflow via `/workflow config`. Next phase uses new setting. No issue — settings are read per-phase.
3. **Reviewer rejects at max rounds**: Escalates to user. Design specifies this.
4. **exit_plan_mode outside plan mode**: Guard relaxed when `workflowSlug` is set. Non-workflow calls still rejected.

## Feasibility Confirmed

- `settings.override()` / `settings.set()` / `settings.clearOverride()` all exist
- `hasOverride()` is straightforward to add (walks `#overrides` tree)
- `ctx.ui.custom()` pattern works for dedicated components
- TUI primitives (Container, Text, SettingsList, Spacer, DynamicBorder) available
- Critic/reviewer agents exist with defined prompts
- `exit_plan_mode` guard is a simple conditional change

## No Simpler Alternatives

The design already chose the simplest viable approach at each decision point:
- Enum settings over new schema types
- Reuse `exit_plan_mode` over new tool
- Dedicated component over extending SettingsSelectorComponent (scope indicators require it)
