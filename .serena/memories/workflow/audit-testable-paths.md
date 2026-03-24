# Workflow Feature Code Path Audit

## File: packages/coding-agent/src/modes/interactive-mode.ts (lines 800-1200)

### 1. handleExitPlanModeTool (lines 816-852)

#### Branch 1: Workflow phase completion (lines 817-826)
- **Condition**: `details.workflowSlug && details.workflowPhase` both present
- **Paths**:
  - Path 1a (line 820): Phase NOT in validPhases list → showWarning + return
  - Path 1b (line 825): Phase IS valid → abort session, call #handleWorkflowPhaseComplete, return
- **State mutations**: Session aborted
- **UI interactions**: Warning shown
- **Side effects**: Session state cleared

#### Branch 2: Non-workflow exit plan mode (lines 828-852)
- **Condition**: No workflow details provided (planModeEnabled must be true)
- **Paths**:
  - Path 2a (line 829): planModeEnabled === false → showWarning + return
  - Path 2b (line 832): planModeEnabled === true → proceed
    - Path 2b-i (line 835): planFilePath provided in details → use it
    - Path 2b-ii (line 835): planFilePath not provided → fallback to this.planModePlanFilePath
    - Path 2b-iii (line 835): both null → call #getPlanFilePath() (returns "local://PLAN.md")
  - Path 2c (line 837): stageContent read fails (returns null) → showError + return
  - Path 2d (line 841): stageContent exists → render preview, handle final stage approval
- **State mutations**: this.planModePlanFilePath updated, session aborted
- **UI interactions**: Warning/error shown, plan preview rendered
- **Side effects**: Plan file read, session aborted

---

### 2. setActiveWorkflow (lines 854-860)

#### Single path (pure state setter)
- **Condition**: Always succeeds (no error paths)
- **Path**: (line 855-859) Set all three private fields + call #updatePlanModeStatus
- **State mutations**: 
  - this.#activeWorkflowSlug = slug
  - this.#activeWorkflowPhase = phase
  - this.#activeWorkflowPhases = phases
  - statusLine.setPlanModeStatus() called
  - UI rerender triggered
- **Side effects**: Status line updated, UI rerender requested

---

### 3. setProposePhases (lines 862-864)

#### Single path (pure state setter)
- **Condition**: Always succeeds
- **Path**: (line 863) Set this.#proposedWorkflowPhases = proposal
- **State mutations**: this.#proposedWorkflowPhases updated
- **Side effects**: None

---

### 4. handleStartWorkflowTool (lines 866-903)

#### Branch 1: User input for slug (lines 868-873)
- **Condition**: await showHookInput called
- **Paths**:
  - Path 1a (line 870): confirmedSlug is falsy (user cancelled) → return
  - Path 1b (line 873): slug.trim() is empty → return
  - Path 1c (line 874): slug has content → proceed
- **UI interactions**: HookInput shown for slug confirmation/editing

#### Branch 2: Collision detection (lines 876-883)
- **Condition**: Check if workflow exists
- **Paths**:
  - Path 2a (line 878): existing workflow found → HookSelector shown (Overwrite/Cancel)
    - Path 2a-i: User selects "Cancel" → return
    - Path 2a-ii: User selects "Overwrite" → proceed (existing state may be clobbered)
  - Path 2b (line 878): No existing workflow → proceed
- **UI interactions**: HookSelector shown if collision detected
- **Side effects**: Potential workflow state overwrite

#### Branch 3: Workflow initialization (lines 886-903)
- **Always succeeds** (createWorkflowState, setActiveWorkflowSlug guaranteed)
- **Paths**:
  - Path 3a (line 887): createWorkflowState(cwd, slug) - creates state.json
  - Path 3b (line 888): setActiveWorkflowSlug(cwd, slug) - writes .active file
  - Path 3c (line 893): session.abort() - clears session
  - Path 3d (line 894): session.newSession({}) - creates fresh session
  - Path 3e (line 896-900): Set active workflow state (slug, "brainstorm", null)
  - Path 3f (line 902): onInputCallback present? → submit brainstorm prompt
    - Path 3f-i: onInputCallback is undefined → skip
    - Path 3f-ii: onInputCallback exists → call with brainstorm prompt
- **State mutations**:
  - Workflow state file created at docs/workflow/{slug}/state.json
  - Active workflow .active file updated
  - Session cleared and restarted
  - this.#activeWorkflowSlug = slug
  - this.#activeWorkflowPhase = "brainstorm"
  - this.#activeWorkflowPhases = null
- **Side effects**: Multiple file I/O operations, session reset, prompt sent to agent

---

### 5. handleSwitchWorkflowTool (lines 905-921)

#### Branch 1: Read workflow state (lines 907-911)
- **Condition**: Check if workflow exists
- **Paths**:
  - Path 1a (line 908): readWorkflowState returns null → showError + return
  - Path 1b (line 908): readWorkflowState succeeds → proceed
- **UI interactions**: Error shown if workflow not found

#### Branch 2: User confirmation (lines 913-917)
- **Condition**: details.confirm field
- **Paths**:
  - Path 2a (line 913): details.confirm === true → skip confirmation, proceed
  - Path 2b (line 913): details.confirm !== true → show HookSelector
    - Path 2b-i: User selects "Cancel" → return
    - Path 2b-ii: User selects "Yes, switch" → proceed
- **UI interactions**: HookSelector shown if !details.confirm

#### Branch 3: Activate workflow (lines 919-921)
- **Always succeeds**
- **Paths**:
  - Path 3a (line 919): Call setActiveWorkflow() with slug, state.currentPhase, state.activePhases
  - Path 3b (line 920): Show status message
- **State mutations**: 
  - this.#activeWorkflowSlug = slug
  - this.#activeWorkflowPhase = state.currentPhase
  - this.#activeWorkflowPhases = state.activePhases ?? null
  - statusLine.setPlanModeStatus() called
- **Side effects**: Status message shown, UI rerender

---

### 6. #handleFinalStageApproval (lines 924-950)

#### Branch 1: User choice selector (lines 925-930)
- **Condition**: await showHookSelector called (4 options)
- **Paths**:
  - Path 1a: User selects "Approve and execute" (lines 932-941)
  - Path 1b: User selects "AI Review" (lines 942-947)
  - Path 1c: User selects "Refine plan" (lines 948-952)
  - Path 1d: User selects "Stay in plan mode" (line 953)
- **UI interactions**: HookSelector shown with 4 options

#### Path 1a: "Approve and execute" (lines 932-941)
- **Condition**: choice === "Approve and execute"
- **Sub-paths**:
  - Path 1a-i: finalPlanFilePath provided in details → use it (line 933)
  - Path 1a-ii: finalPlanFilePath null → fallback to details.planFilePath (line 933)
  - Path 1a-iii: #approvePlan succeeds → return (no error shown)
  - Path 1a-iv: #approvePlan throws error → catch & showError, then return
- **Error handling**: try/catch on #approvePlan
- **State mutations**: Plan finalized (file rename, session state)
- **Side effects**: Plan file operations, session cleared, new session started

#### Path 1b: "AI Review" (lines 942-947)
- **Condition**: choice === "AI Review"
- **Paths**:
  - Path 1b-i: onInputCallback is undefined → no action
  - Path 1b-ii: onInputCallback exists → submit planReviewInstruction prompt
- **State mutations**: None (just submits prompt)
- **Side effects**: Prompt sent to agent

#### Path 1c: "Refine plan" (lines 948-952)
- **Condition**: choice === "Refine plan"
- **Paths**:
  - Path 1c-i: User provides refinement text → call editor.setText(refinement)
  - Path 1c-ii: User cancels (refinement is undefined) → no action
- **State mutations**: Editor text changed
- **Side effects**: Editor state changed, UI rerender

#### Path 1d: "Stay in plan mode" (line 953)
- **Condition**: choice === "Stay in plan mode"
- **Paths**: No action - agent continues planning
- **State mutations**: None
- **Side effects**: None

---

### 7. #handleWorkflowPhaseComplete (lines 958-1049)

#### Branch 1: Read phase output (lines 959-966)
- **Condition**: Check if phase output file exists
- **Paths**:
  - Path 1a (line 960): phasePlanFilePath from details OR default to `local://{PHASE}.md`
  - Path 1b (line 961): #readPlanFile returns null → showError + return
  - Path 1c (line 961): #readPlanFile succeeds → proceed
- **Error handling**: File I/O with null check
- **Side effects**: File read (resolves local:// URLs)

#### Branch 2: Brainstorm phase proposal (lines 968-989)
- **Condition**: phase === "brainstorm" AND this.#proposedWorkflowPhases exists
- **Paths**:
  - Path 2a (line 970): proposedWorkflowPhases is set → show HookSelector with 3 options
    - Path 2a-i: User selects "Accept" → approvedPhases = proposal.phases
    - Path 2a-ii: User selects "Edit phases" → show HookInput with comma/space/arrow parser
      - Path 2a-ii-α: User provides edited phases → parse & set approvedPhases
      - Path 2a-ii-β: User cancels (edited is undefined) → approvedPhases stays undefined
    - Path 2a-iii: User selects "Reject (use global settings)" → approvedPhases stays undefined
  - Path 2b (line 970): proposedWorkflowPhases is null/undefined → skip (approvedPhases = undefined)
- **State mutations**: this.#proposedWorkflowPhases cleared to null (line 972)
- **UI interactions**: HookSelector shown, optional HookInput shown
- **Parser**: Regex `/[\s,\u2192]+/` for phase separators (space, comma, arrow)

#### Branch 3: Approval gate flow (lines 991-1048)
- **Condition**: details.reviewCompleted field
- **Paths**:
  - Path 3a (line 995): details.reviewCompleted === true → skip approval gate, go straight to user approval
    - Path 3a-i (line 996): runUserApproval called
    - Path 3a-ii (line 997): this.#reviewRoundCount deleted for roundKey
    - Path 3a-iii (line 998): Call #handleApprovalResult
  - Path 3b (line 1000): details.reviewCompleted not set/false → run approval gate
    - Path 3b-i (line 1002): result.reviewPrompt is present → agent review mode
    - Path 3b-ii (line 1002): result.reviewPrompt is undefined → user approval or no-approval mode
- **State mutations**: this.#reviewRoundCount map updated/deleted

#### Path 3b-i: Agent review mode (lines 1002-1024)
- **Condition**: result.reviewPrompt truthy
- **Paths**:
  - Path 3b-i-α (line 1004): Get currentRound from this.#reviewRoundCount[roundKey], default 0, increment
  - Path 3b-i-β (line 1005): Get maxRounds from settings, parse integer, default 3
  - Path 3b-i-γ (line 1008): currentRound >= maxRounds → escalate to user approval
    - Path 3b-i-γ-1 (line 1010): showWarning with round count
    - Path 3b-i-γ-2 (line 1011): runUserApproval called
    - Path 3b-i-γ-3 (line 1012): this.#reviewRoundCount deleted
    - Path 3b-i-γ-4 (line 1013): Call #handleApprovalResult
  - Path 3b-i-δ (line 1008): currentRound < maxRounds → continue review
    - Path 3b-i-δ-1 (line 1017): this.#reviewRoundCount.set(roundKey, currentRound)
    - Path 3b-i-δ-2 (line 1018): onInputCallback exists? → submit review prompt
    - Path 3b-i-δ-3 (line 1020): return (agent review continues)
- **Integer parsing edge cases**:
  - NaN case → default 3
  - n < 1 → default 3
  - Valid n → use n
- **State mutations**: this.#reviewRoundCount tracked per roundKey, incremented each round
- **Side effects**: Review prompt sent to agent, warning shown on max rounds reached

#### Path 3b-ii: Approval result (lines 1022-1024)
- **Condition**: result.reviewPrompt is undefined
- **Paths**:
  - Path 3b-ii-α (line 1022): this.#reviewRoundCount deleted for roundKey
  - Path 3b-ii-β (line 1023): Call #handleApprovalResult (with user approval or no-approval result)
- **State mutations**: this.#reviewRoundCount cleaned up
- **Side effects**: Call #handleApprovalResult

---

### 8. #handleApprovalResult (lines 1051-1120)

#### Branch 1: Not approved (lines 1052-1060)
- **Condition**: result.approved === false
- **Paths**:
  - Path 1a (line 1053): Extract reason from result (only present if result.reason exists)
  - Path 1b (line 1054): reason exists AND onInputCallback exists → submit reason as message
    - Path 1b-i: onInputCallback is undefined → skip
    - Path 1b-ii: onInputCallback exists → call with refinement/rejection reason
  - Path 1c (line 1058): return (no artifact persisted)
- **State mutations**: None
- **Side effects**: Reason message sent to agent (if present and callback available)

#### Branch 2: Approved (lines 1061-1117)
- **Condition**: result.approved === true

#### Branch 2a: Persist artifact (lines 1062-1069)
- **Condition**: Always attempted
- **Paths**:
  - Path 2a-i: writeWorkflowArtifact succeeds
    - Creates: docs/workflow/{slug}/{phase}.md
    - Updates: docs/workflow/{slug}/state.json (currentPhase, artifacts map)
    - Optional: Writes activePhases to state if provided
    - Shows success status
  - Path 2a-ii: writeWorkflowArtifact throws error → showError, return (no further processing)
- **Error handling**: try/catch on writeWorkflowArtifact
- **Side effects**: Multiple file writes to docs/workflow/

#### Branch 2b: Update active workflow tracking (lines 1071-1081)
- **Condition**: Always attempted
- **Paths**:
  - Path 2b-i: readWorkflowState succeeds
    - Path 2b-i-α: updatedState exists → getNextPhase(updatedState)
      - Path 2b-i-α-1: nextPhase found → setActiveWorkflow(slug, nextPhase, activePhases)
      - Path 2b-i-α-2: nextPhase null (end of workflow) → setActiveWorkflow(slug, phase, activePhases)
    - Path 2b-i-β: updatedState is null (shouldn't happen) → setActiveWorkflow(slug, phase, activePhases)
  - Path 2b-ii: readWorkflowState throws error → catch & setActiveWorkflow(slug, phase, null)
    - Falls back to completed phase, no activePhases
- **Error handling**: try/catch on readWorkflowState
- **State mutations**: 
  - this.#activeWorkflowSlug = slug
  - this.#activeWorkflowPhase = nextPhase ?? phase
  - this.#activeWorkflowPhases = activePhases ?? null
  - statusLine updated

#### Branch 2c: Plan mode integration (lines 1083-1098)
- **Condition**: Check planModeEnabled and finalPlanFilePath
- **Paths**:
  - Path 2c-i (line 1084): planModeEnabled === true AND details.finalPlanFilePath exists → execute plan approval flow
    - Path 2c-i-α: #approvePlan succeeds → silent (no message)
    - Path 2c-i-β: #approvePlan throws error → catch & showError
  - Path 2c-ii (line 1092): planModeEnabled === true BUT no finalPlanFilePath → call #exitPlanMode()
  - Path 2c-iii (line 1092): planModeEnabled === false → skip (no action)
- **Error handling**: try/catch on #approvePlan
- **Side effects**: Plan mode exited, potential file operations

#### Branch 2d: Offer phase continuation (lines 1100-1105)
- **Condition**: nextPhase exists
- **Paths**:
  - Path 2d-i: Show HookSelector with "Continue" / "Stop here"
    - Path 2d-i-α: User selects "Continue" → editor.setText(`/workflow {nextPhase} {slug}`)
    - Path 2d-i-β: User selects "Stop here" → no action
  - Path 2d-ii: nextPhase is null → skip (no continuation offered)
- **UI interactions**: HookSelector shown with phase continuation options
- **State mutations**: Editor text set (if continue selected)
- **Side effects**: None (editor just staged, awaits user confirmation)

---

### 9. #updatePlanModeStatus (lines 613-648)

#### Branch 1: Build status object (lines 615-637)
- **Condition**: Check planModeEnabled, planModePaused, readOnlyMode, active workflow
- **Paths**:
  - Path 1a (line 617): readOnly = this.session.getReadOnlyMode?.() ?? false
    - Handles optional method (nullish coalescing)
  - Path 1b (line 619-629): planModeEnabled OR planModePaused
    - Creates status object with enabled & paused fields
    - Optionally adds readOnly field
  - Path 1c (line 630-633): readOnly true BUT neither plan mode nor paused
    - Creates status = { enabled: false, paused: false, readOnly: true }
  - Path 1d (line 635-639): this.#activeWorkflowSlug exists
    - Ensures status object created (or init if null)
    - Sets workflowSlug field
    - Optionally adds workflowPhase & workflowPhases if present
  - Path 1e (line 641): status is undefined after all checks
    - statusLine.setPlanModeStatus(undefined) called → clears status bar
- **State mutations**: statusLine.setPlanModeStatus called, updateEditorTopBorder called, UI rerender requested
- **Side effects**: Status bar updated, editor border updated, UI rerender

---

### 10. #renderPlanPreview (lines 773-781)

#### Single path (pure UI rendering)
- **Condition**: Always succeeds
- **Paths**:
  - Path 1: Add spacer, border, title, spacer, markdown, border to chatContainer
  - Path 2: Call ui.requestRender()
- **State mutations**: chatContainer children modified
- **Side effects**: UI rerender requested, visual content added to chat

---

## Testable Conditions Summary

### Error paths:
1. Invalid workflow phase name → warning shown
2. Plan mode not active → warning shown
3. Stage file not found → error shown
4. Workflow state file not found → error shown
5. Plan approve fails → error shown
6. Phase output file not found → error shown
7. Workflow artifact persist fails → error shown
8. readWorkflowState throws → caught & fallback applied

### Edge cases:
1. Empty slug after trim → return
2. User cancels HookInput/HookSelector → undefined/null returned
3. No onInputCallback defined → skip prompt submission
4. approvedPhases parsing with arrow character (U+2192)
5. maxReviewRounds setting: NaN, <1, or valid int
6. nextPhase = null (end of workflow) → show completed phase instead
7. finalPlanFilePath null → fallback to planFilePath

### State tracking:
1. #activeWorkflowSlug, #activeWorkflowPhase, #activeWorkflowPhases
2. #proposedWorkflowPhases (cleared after brainstorm confirmation)
3. #reviewRoundCount Map<roundKey, count> (enforces max iterations)
4. planModeEnabled, planModePaused flags
5. readOnlyMode getter from session

### UI interactions:
1. HookInput: slug confirmation, phase editing, refinement text
2. HookSelector: overwrite confirmation, next step selection, phase proposal, approval, continuation offer
3. Status messages: success, warning, error
4. Plan preview rendering in chat
5. Editor text changes for refinement/continuation

### File operations:
1. Create: docs/workflow/{slug}/state.json, docs/workflow/{slug}/{phase}.md
2. Read: state.json, {phase}.md, PLAN.md via local:// URL resolution
3. Update: state.json (currentPhase, artifacts, activePhases)
4. Write: .active file (setActiveWorkflowSlug)

### Session mutations:
1. session.abort() in workflow entry points
2. session.newSession({}) on workflow start
3. session.setActiveToolsByName() in plan approval
4. session.prompt() with synthetic flags
5. session.dispose() in shutdown