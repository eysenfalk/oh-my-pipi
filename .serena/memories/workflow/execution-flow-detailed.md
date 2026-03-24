# Workflow System: Complete Execution Flow

## Files Read
1. `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts` (531 lines) — WorkflowCommand CLI
2. `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/artifacts.ts` — State/artifact persistence
3. `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/approval.ts` — Approval gate logic
4. `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/config-component.ts` — Phase config UI
5. Seven prompt templates (brainstorm, spec, design, plan, execute, verify, finish)
6. `packages/coding-agent/src/modes/interactive-mode.ts` methods: handleExitPlanModeTool, handleStartWorkflowTool, #handleWorkflowPhaseComplete, setProposePhases

## Phase Sequence & Prerequisite Chain

```
BRAINSTORM → SPEC → DESIGN → PLAN → EXECUTE → VERIFY → FINISH
    ↓         ↓        ↓        ↓       ↓        ↓        ↓
Required for all. Each phase can be skipped via activePhases config but prerequisite artifacts must exist to proceed to the next phase.
```

## WorkflowState Structure
```json
{
  "slug": "YYYY-MM-DD-topic",
  "currentPhase": "brainstorm|spec|design|plan|execute|verify|finish",
  "artifacts": {
    "brainstorm": "docs/workflow/{slug}/brainstorm.md",
    "spec": "docs/workflow/{slug}/spec.md",
    ...
  },
  "activePhases": ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"],  // Optional per-slug phase filter
  "status": "active|abandoned"  // Optional; defaults to active
}
```

Files: `docs/workflow/{slug}/state.json` + `docs/workflow/.active` (current workflow slug)

## Phase-by-Phase Execution Flow

### BRAINSTORM
**Entry:** `/workflow brainstorm <topic>` or agent calls `start_workflow(topic, slug?)`
**Files Written:**
- `docs/workflow/{slug}/state.json` — initial state created
- `docs/workflow/.active` — sets active workflow
**Local writes during phase:**
- `local://BRAINSTORM.md` — exploratory doc (readonly reference in phase, artifact persisted on approval)
- `docs/workflow/{slug}/learnings.md` — appended with brainstorm learnings
**Tool Calls:**
- `propose_phases({phases: [], rationale})` — agent proposes which phases to run. Proposal stored in-memory in InteractiveMode.#proposedWorkflowPhases
- `exit_plan_mode({title: "BRAINSTORM", workflowSlug, workflowPhase: "brainstorm"})` — signals phase completion
**Approval Flow:**
1. Phase proposal dialog (Accept / Edit phases / Reject):
   - "Accept" → approvedPhases = proposal.phases (saved to state.activePhases on persist)
   - "Edit phases" → user manually edits phase list
   - "Reject" → approvedPhases undefined; global settings used (no activePhases saved to state)
2. Then standard approval gate (via settings.workflow.phases.brainstorm.approval):
   - "none" → approved immediately
   - "user" → three-option dialog: Approve / Refine / Reject
   - "agent" → `reviewPrompt` returned; agent dispatched with review instructions
   - "both" → agent review first, then user approval after
3. If approved:
   - Content written to `docs/workflow/{slug}/brainstorm.md`
   - state.currentPhase = brainstorm
   - state.artifacts.brainstorm = path reference
   - state.activePhases set if user customized phases
**Next Phase:** Offers user continue to spec; updates status bar with "Next: spec"
**Commands:**
- `/workflow skip brainstorm` — writes "(skipped)" as artifact
- `/workflow back brainstorm` — re-enters brainstorm if completed

### SPEC
**Entry:** `/workflow spec [slug]`
**Prerequisite:** brainstorm artifact must exist; if brainstorm not in activePhases, skipped (no artifact required)
**Files Provided to Agent:**
- `local://BRAINSTORM.md` — read-only reference (pre-populated via newSession setup callback)
- `{{brainstormRef}}` template parameter in prompt
**Local writes during phase:**
- `local://SPEC.md` — formal RFC 2119 spec
- `docs/workflow/{slug}/learnings.md` — appended with spec learnings
**Tool Calls:**
- `exit_plan_mode({title: "SPEC", workflowSlug, workflowPhase: "spec"})`
**Approval Flow:** Same gate as brainstorm, but reads global settings for spec phase
**Next Phase:** Offers continue to design
**Persisted on Approval:**
- `docs/workflow/{slug}/spec.md`
- state.artifacts.spec = path
- state.currentPhase = spec

### DESIGN
**Entry:** `/workflow design [slug]`
**Prerequisite:** spec artifact must exist
**Files Provided to Agent:**
- `local://SPEC.md`
- `local://BRAINSTORM.md` (if brainstorm completed)
- `{{specRef}}`, `{{brainstormRef}}` in prompt
**Local writes during phase:**
- `local://DESIGN.md` — architecture/component design
- `docs/workflow/{slug}/learnings.md` — appended learnings
**Tool Calls:**
- `exit_plan_mode({title: "DESIGN", workflowSlug, workflowPhase: "design"})`
**Next Phase:** Offers continue to plan
**Persisted on Approval:**
- `docs/workflow/{slug}/design.md`
- state.artifacts.design = path

### PLAN
**Entry:** `/workflow plan [slug]`
**Prerequisite:** design artifact must exist
**Files Provided to Agent:**
- `local://SPEC.md`
- `local://DESIGN.md`
- `{{specRef}}`, `{{designRef}}` in prompt
**Local writes during phase:**
- `local://PLAN.md` — bite-sized tasks with TDD steps, agent tier, parallelism
- `docs/workflow/{slug}/learnings.md` — appended learnings
**Tool Calls:**
- `exit_plan_mode({title: "PLAN", workflowSlug, workflowPhase: "plan"})`
**Note:** Prompt instructs agent to "dispatch a critic agent to review the plan (max 3 iterations)"
**Approval Flow:** Same gate, but tracks review rounds per `${slug}/${phase}` key
- If agent review enabled: reviewPrompt returned → agent looped back to refine
- Max review rounds enforced: if ≥ maxReviewRounds, escalates to user approval
**Next Phase:** Offers continue to execute
**Persisted on Approval:**
- `docs/workflow/{slug}/plan.md`
- state.artifacts.plan = path

### EXECUTE
**Entry:** `/workflow execute [slug]`
**Prerequisite:** plan artifact must exist
**Files Provided to Agent:**
- `local://PLAN.md`
- `local://SPEC.md`
- `local://DESIGN.md` (if design completed)
- All previous phase artifacts available as uppercase in local://
**Local writes during phase:**
- `local://EXECUTE.md` — retrospective (what was implemented, what worked, improvements)
- Repo files modified as per plan
**Tool Calls:**
- `exit_plan_mode({title: "EXECUTE", workflowSlug, workflowPhase: "execute"})`
**Approval:** Standard gate
**Next Phase:** Offers continue to verify
**Persisted on Approval:**
- `docs/workflow/{slug}/execute.md`
- state.artifacts.execute = path

### VERIFY
**Entry:** `/workflow verify [slug]`
**Prerequisite:** execute artifact must exist; spec artifact must exist
**Files Provided to Agent:**
- `local://SPEC.md` (for acceptance criteria)
- `local://PLAN.md` (for expected outcomes)
- `local://EXECUTE.md` (automatically provided)
**Local writes during phase:**
- `local://VERIFY.md` — verification findings (test counts, PASS/FAIL per criterion, gaps)
**Tool Calls:**
- `exit_plan_mode({title: "VERIFY", workflowSlug, workflowPhase: "verify"})`
**Approval:** Standard gate
**Next Phase:** Offers continue to finish
**Persisted on Approval:**
- `docs/workflow/{slug}/verify.md`
- state.artifacts.verify = path

### FINISH
**Entry:** `/workflow finish [slug]`
**Prerequisite:** verify artifact must exist
**Files Provided to Agent:**
- All previous phase artifacts
**Local writes during phase:**
- `local://FINISH.md` — retrospective (delivered, deferred, workflow assessment, learnings)
**Tool Calls:**
- `exit_plan_mode({title: "FINISH", workflowSlug, workflowPhase: "finish"})`
**Approval:** Standard gate
**Persisted on Approval:**
- `docs/workflow/{slug}/finish.md`
- state.artifacts.finish = path
**Workflow Status:** After finish approval, workflow marked complete

## Approval Gate (runApprovalGate)
Settings-driven per phase at `workflow.phases.{phase}.{approval|reviewAgent|maxReviewRounds}`.

**Approval Mode Options:**
- `none` → {approved: true}
- `user` → dialog with 3 options
  - "Approve" → {approved: true}
  - "Refine" → user inputs reason, {approved: false, reason}
  - "Reject" → two sub-options:
    - "Retry phase" → {approved: false, reason: "Rejected. Please retry..."}
    - "Abandon phase" → {approved: false, reason: "Phase abandoned"}
- `agent` → {approved: false, reviewPrompt: "..."}
  - Prompt instructs agent to dispatch reviewer and check `local://{PHASE}.md`
  - Reviewer assesses quality, calls exit_plan_mode with output
  - Agent loops until approval or max rounds hit
- `both` → same as agent, then user approval after

**Review Round Tracking:**
- Key: `${slug}/${phase}`
- Incremented on each agent review iteration
- If currentRound ≥ maxRounds (default 3), escalates to user approval
- Cleared after approval result processed

## Phase Continuation Logic

**In handleApprovalResult (after approval):**
1. Content persisted to artifact file
2. state.currentPhase = phase
3. state.artifacts[phase] = path
4. state.activePhases = approvedPhases (if user customized in brainstorm)
5. UI shows status: "X phase approved"
6. Lookup next phase: `getNextPhase(state)` returns next incomplete phase in sequence, respecting activePhases filter
7. If next phase exists: dialog "Continue to {nextPhase}?" with "Continue" / "Stop here"
   - "Continue" → editor populated with `/workflow {nextPhase} {slug}`
   - Agent then executes this command, triggering phase start

**If not approved:** reason sent back to agent as message so it refines output and calls exit_plan_mode again

## Data Flow: Phase Input/Output

**#populateLocalSetup(cwd, slug, phases):**
Reads all artifacts for specified phases and returns a setup callback. On newSession, callback writes them to `{sessionArtifactsDir}/local/`:
- `local://BRAINSTORM.md` (if brainstorm completed)
- `local://SPEC.md` (if spec completed)
- etc.

**Artifact File Structure:**
```
docs/workflow/{slug}/
├── state.json                 # Workflow state (phases, artifacts, status, activePhases)
├── brainstorm.md              # Phase artifact (content of local://BRAINSTORM.md on approval)
├── spec.md
├── design.md
├── plan.md
├── execute.md
├── verify.md
├── finish.md
└── learnings.md               # Cumulative per-phase learnings (appended, not overwritten)
```

## Special Commands

**`/workflow back [phase] [slug]`**
- Lists completed phases (those with artifacts)
- User selects one via UI
- Dispatches to that phase: re-reads artifact, activates phase, new session, renders prompt
- Allows editing prior phases

**`/workflow skip <phase> [slug]`**
- Writes "(skipped)" as artifact for that phase
- Phase marked complete so next phase can proceed
- No approval gate

**`/workflow abandon [slug]`**
- Sets state.status = "abandoned"
- Clears .active file

**`/workflow resume [slug]`**
- Gets next incomplete phase via getNextPhase(state)
- Dispatches to that phase
- If all complete: shows status message

**`/workflow switch [slug]`**
- Lists all workflows
- User selects; calls resume on that slug
- Updates .active file

**`/workflow config`**
- Opens interactive TUI settings panel
- Allows toggling per-phase: enabled, approval mode, reviewAgent, maxReviewRounds
- Scope: session (override) or global (persistent)
- `*` marker shows overridden settings

## Exit Plan Mode Integration

**exit_plan_mode tool details:**
```ts
{
  title: "PHASE_NAME",
  workflowSlug: "slug",
  workflowPhase: "brainstorm|spec|...",
  planFilePath?: string,  // Defaults to local://{PHASE}.md
  reviewCompleted?: boolean,  // Skip agent review, go to user approval
  finalPlanFilePath?: string  // For plan mode (non-workflow)
}
```

**Handled by InteractiveMode.handleExitPlanModeTool:**
- If workflowSlug + workflowPhase present: delegates to #handleWorkflowPhaseComplete
- Otherwise: triggers plan mode approval flow (legacy non-workflow path)

## State Transitions State Machine

```
INITIAL → (user runs `/workflow brainstorm TOPIC`)
  ↓
BRAINSTORM_PENDING
  ├─ (agent calls propose_phases)
  │   → proposes list stored in memory
  ├─ (agent calls exit_plan_mode)
  │   → phase proposal dialog if proposed
  │   → approval gate runs
  │   ├─ NOT APPROVED
  │   │   → reason sent back to agent
  │   │   → agent refines and calls exit_plan_mode again
  │   ├─ APPROVED
  │   │   → artifact persisted
  │   │   → state.activePhases = approved list (if user customized)
  │   │   → offer continue to SPEC
  │   │   → [user chooses Continue]
  │   └─ CONTINUE
  │       → editor populated with `/workflow spec slug`
  │
→ SPEC_PENDING
  ├─ (agent calls exit_plan_mode)
  │   → approval gate runs
  │   ├─ NOT APPROVED → loop
  │   ├─ APPROVED
  │   │   → offer continue to DESIGN
  │   └─ CONTINUE → `/workflow design slug`
  │
→ DESIGN_PENDING ... [same pattern] ...
→ PLAN_PENDING ... [with agent review rounds] ...
→ EXECUTE_PENDING
→ VERIFY_PENDING
→ FINISH_PENDING
  └─ COMPLETE
```

## Prompt Templates Summary

All templates in `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/prompts/`:

| Phase | Template | Key Template Vars | Agent Instructions |
|-------|----------|-------------------|-------------------|
| brainstorm | brainstorm-start.md | topic, workflowDir, slug | Explore idea; propose phases; exit_plan_mode |
| spec | spec-start.md | brainstormRef, slug | RFC 2119 spec; update docs/; exit_plan_mode |
| design | design-start.md | specRef, brainstormRef, slug | Architecture doc; ADRs; exit_plan_mode |
| plan | plan-start.md | specRef, designRef, slug | Decompose tasks; TDD steps; dispatch critic; exit_plan_mode |
| execute | execute-start.md | planRef, specRef, designRef, slug | Follow TDD; dispatch agents; update docs; exit_plan_mode |
| verify | verify-start.md | specRef, planRef, slug | Run tests; verify acceptance criteria; gate function; exit_plan_mode |
| finish | finish-start.md | slug | Finalize docs; present 4 merge/PR/keep/discard options; exit_plan_mode |
