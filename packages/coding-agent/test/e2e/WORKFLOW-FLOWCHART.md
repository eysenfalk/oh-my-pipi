# OMP Workflow: Complete Flowchart

Every decision point, every file, every user-facing dialog from `omp` launch to workflow completion.

---

## 1. Entry: User Launches OMP

```
User runs `omp` (or `omp launch`)
    |
    v
CLI parses args (cli.ts)
    |
    v
--mode flag?
    |-- rpc     --> runRpcMode()   (stdin/stdout JSONL, no TUI)
    |-- print   --> runPrintMode() (single prompt, JSON output)
    |-- (none)  --> InteractiveMode
    v
InteractiveMode(session, version, ..., terminal?)
    |
    v
InteractiveMode.init()
    |-- KeybindingsManager.create()
    |-- refreshSlashCommandState()
    |-- getRecentSessions()
    |-- initHooksAndCustomTools()
    |   |-- creates ExtensionUIContext (select, confirm, input, notify)
    |   |-- wires setToolUIContext so tools can access UI
    |   |-- creates HookCommandContext with:
    |   |     startWorkflow    --> handleStartWorkflowTool()
    |   |     activateWorkflowPhase --> setActiveWorkflow() + setActiveWorkflowSlug()
    |   |     switchWorkflow   --> handleSwitchWorkflowTool()
    |   |     newSession, branch, navigateTree, waitForIdle, compact
    |   v
    |-- ui.start() --> terminal.start(onInput, onResize)
    |-- #restoreModeFromSession()
    |-- #subscribeToAgent()
    v
Editor ready. User can type.
```

---

## 2. User Starts a Workflow

### 2a. Via `/workflow brainstorm <topic>`

```
User types: /workflow brainstorm <topic>
    |
    v
session.prompt(text) --> detects /workflow prefix
    |
    v
WorkflowCommand.execute(["brainstorm", ...rest], ctx)
    |
    v
#startBrainstorm(rest, ctx)
    |
    v
topic = rest.join(" ")
    |
    v
topic is empty?
    |-- YES --> ctx.hasUI?
    |   |-- YES --> show input dialog "Brainstorm topic" --> user types topic
    |   |   |-- user cancels (Escape) --> return (nothing happens)
    |   |   |-- user submits --> recursive call with [topic]
    |   |-- NO  --> return error "Usage: /workflow brainstorm <topic>"
    |
    |-- NO  --> ctx.startWorkflow({ topic })
                    |
                    v
              handleStartWorkflowTool({ topic })
```

### 2b. handleStartWorkflowTool (InteractiveMode)

```
handleStartWorkflowTool({ topic, slug? })
    |
    v
recommendedSlug = slug ?? generateSlug(topic)
    |   generateSlug: "YYYY-MM-DD-<topic-sanitized>"
    |   sanitized = lowercase, alphanum+dash, max 50 chars
    |
    v
showHookInput("Workflow slug (confirm or edit)", recommendedSlug)
    |   *** USER SEES: text input with recommended slug as placeholder ***
    |
    v
User response?
    |-- cancels (Escape)    --> return (nothing happens)
    |-- confirms/edits slug --> confirmedSlug = trimmed input
    v
confirmedSlug is empty after trim?
    |-- YES --> return (nothing happens)
    |-- NO  --> continue
    v
readWorkflowState(cwd, slug) to check collision
    |
    v
Existing workflow with this slug?
    |-- YES --> showHookSelector("Workflow '<slug>' already exists. Overwrite?",
    |           ["Overwrite", "Cancel"])
    |   |-- "Overwrite" --> continue
    |   |-- "Cancel"    --> return (nothing happens)
    |
    |-- NO --> continue
    v
createWorkflowState(cwd, slug)
    |   CREATES: docs/workflow/<slug>/state.json
    |   CONTENT: { slug, currentPhase: "brainstorm", artifacts: {} }
    |
    v
setActiveWorkflowSlug(cwd, slug)
    |   CREATES: docs/workflow/.active
    |   CONTENT: <slug>
    |
    v
session.abort()     --> stops any running agent turn
session.newSession() --> creates fresh session
    |
    v
#activeWorkflowSlug  = slug
#activeWorkflowPhase = "brainstorm"
#activeWorkflowPhases = null
#updatePlanModeStatus()
    |
    v
renderPromptTemplate(brainstormPrompt, { topic, workflowDir, slug, workflowPhase })
    |   READS: prompts/brainstorm-start.md
    |   INJECTS: {{topic}}, {{slug}}, {{workflowDir}}, {{workflowPhase}}
    |
    v
onInputCallback(startPendingSubmission({ text: prompt }))
    |   Submits the rendered prompt as if the user typed it
    |
    v
Agent starts processing brainstorm prompt
    |   *** AGENT IS NOW BRAINSTORMING ***
```

---

## 3. Agent Works on a Phase

```
Agent processes the phase prompt
    |
    v
Agent uses tools (read, write, search, bash, etc.)
    |
    v
Agent may call propose_phases tool (brainstorm only)
    |-- EventController detects tool_execution_end for "propose_phases"
    |-- Calls setProposePhases({ phases: [...], rationale: "..." })
    |-- Stored in #proposedWorkflowPhases for use during approval
    |
    v
Agent writes output to local://<PHASE>.md
    |   e.g., local://BRAINSTORM.md, local://SPEC.md
    |   RESOLVED TO: <artifactsDir>/local/<PHASE>.md
    |     or: <tmpdir>/omp-local/<sessionId>/local/<PHASE>.md
    |
    v
Agent calls exit_plan_mode tool with:
    |   title: "<PHASE>"
    |   workflowSlug: "<slug>"         (MAY BE OMITTED by some models)
    |   workflowPhase: "<phase>"       (MAY BE OMITTED by some models)
    |   reviewCompleted: true/false    (only set during review rounds)
    |
    v
ExitPlanModeTool.execute() validates args, reads plan file
    |   RETURNS: AgentToolResult with .details = ExitPlanModeDetails
    |
    v
EventController.handleEvent() detects tool_execution_end for "exit_plan_mode"
    |
    v
event.isError?
    |-- YES --> silently skip (no notification to user)
    |-- NO  --> event.result.details exists?
        |-- NO  --> silently skip
        |-- YES --> ctx.handleExitPlanModeTool(details)
```

---

## 4. Phase Completion: handleExitPlanModeTool

```
handleExitPlanModeTool(details)
    |
    v
FALLBACK: workflowSlug  = details.workflowSlug  || #activeWorkflowSlug
          workflowPhase = details.workflowPhase || #activeWorkflowPhase
    |
    v
workflowSlug AND workflowPhase both present?
    |
    |-- YES --> valid phase name? (brainstorm|spec|design|plan|execute|verify|finish)
    |   |-- NO  --> showWarning("Unknown workflow phase ...") --> return
    |   |-- YES --> session.abort()
    |   |           |
    |   |           v
    |   |       #handleWorkflowPhaseComplete(slug, phase, details)
    |   |       (see Section 5)
    |
    |-- NO (no active workflow) -->
        |
        v
    planModeEnabled?
        |-- NO  --> showWarning("Plan mode is not active.") --> return
        |-- YES --> standard plan mode approval (non-workflow)
```

---

## 5. Phase Completion: #handleWorkflowPhaseComplete

```
#handleWorkflowPhaseComplete(slug, phase, details)
    |
    v
Resolve plan file path:
    phasePlanFilePath = details.planFilePath || "local://<PHASE>.md"
    |
    v
#readPlanFile(phasePlanFilePath)
    |   Resolves local:// URL to filesystem path
    |   Reads file content
    |
    v
File found?
    |-- NO  --> showError("Phase output not found at <path>...") --> return
    |-- YES --> content = file content
    v
#renderPlanPreview(content)
    |   Shows preview in TUI chat area
    |
    v
========================================
BRAINSTORM-ONLY: Phase Proposal Handling
========================================
    |
phase === "brainstorm" AND #proposedWorkflowPhases is set?
    |
    |-- NO  --> skip to approval gate
    |
    |-- YES -->
        phaseList = phases.join(" -> ")
        |
        v
    showHookSelector("Proposed workflow phases: <phaseList>",
        ["Accept", "Edit phases", "Reject (use global settings)"])
        |
        |-- "Accept"  --> approvedPhases = proposal.phases
        |
        |-- "Edit phases" --> showHookInput("Edit phases (space or comma separated)", phaseList)
        |   |-- user edits --> parse by /[\s,->]+/ --> approvedPhases = parsed phases
        |   |-- user cancels --> approvedPhases = undefined (uses global settings)
        |
        |-- "Reject (use global settings)" --> approvedPhases = undefined
        |
        |-- cancel (Escape) --> approvedPhases = undefined
        v
========================================
    |
    v
details.reviewCompleted? (agent review mode re-entry)
    |
    |-- YES --> runUserApproval(phase, ctx) directly (skip approval gate)
    |           clear #reviewRoundCount for this phase
    |           --> #handleApprovalResult (Section 6)
    |
    |-- NO  --> runApprovalGate(phase, ctx)
                (see Section 5a)
```

### 5a. Approval Gate: runApprovalGate

```
runApprovalGate(phase, ctx)
    |
    v
Read settings: workflow.phases.<phase>.approval
    |
    v
Approval mode?
    |
    |-- "none" --> return { approved: true }
    |              (skip straight to #handleApprovalResult)
    |
    |-- "user" --> runUserApproval(phase, ctx)
    |              (see Section 5b)
    |
    |-- "agent" -->
    |   Build review prompt for reviewer/critic agent
    |   return { approved: false, reviewPrompt: "..." }
    |   (see Section 5c)
    |
    |-- "both" -->
        Build combined review prompt (agent reviews first, then user approves)
        return { approved: false, reviewPrompt: "..." }
        (see Section 5c)
```

### 5b. User Approval: runUserApproval

```
runUserApproval(phase, ctx)
    |
    v
showHookSelector("<Phase> phase complete -- review and approve",
    ["Approve", "Refine", "Reject"])
    |
    *** USER SEES: Three-option selector ***
    |
    |-- "Approve" --> return { approved: true }
    |                 --> #handleApprovalResult (Section 6)
    |
    |-- "Refine"  --> showHookInput("What needs refinement?")
    |   |
    |   *** USER SEES: Text input for refinement feedback ***
    |   |
    |   |-- user types feedback --> return { approved: false, reason: <feedback> }
    |   |-- user cancels        --> return { approved: false, reason: "Refinement requested" }
    |   v
    |   --> #handleApprovalResult (Section 6, not approved path)
    |
    |-- "Reject"  --> showHookSelector("Rejected -- what next?",
    |       ["Retry phase", "Abandon phase"])
    |   |
    |   *** USER SEES: Two-option selector ***
    |   |
    |   |-- "Retry phase"   --> return { approved: false, reason: "Rejected. Please retry..." }
    |   |-- "Abandon phase" --> return { approved: false, reason: "Phase abandoned." }
    |   v
    |   --> #handleApprovalResult (Section 6, not approved path)
    |
    |-- cancel (Escape) --> return { approved: false }
                            --> #handleApprovalResult (Section 6, silent return)
```

### 5c. Agent Review Flow

```
Approval gate returned { approved: false, reviewPrompt }
    |
    v
Track review round: currentRound = (#reviewRoundCount[slug/phase] ?? 0) + 1
    |
    v
currentRound >= maxReviewRounds? (default: 3)
    |
    |-- YES --> showWarning("Maximum N review rounds reached. Escalating to user approval.")
    |           runUserApproval(phase, ctx) --> #handleApprovalResult (Section 6)
    |           clear #reviewRoundCount
    |
    |-- NO  --> #reviewRoundCount[slug/phase] = currentRound
                onInputCallback(reviewPrompt)
                |
                *** AGENT RE-RUNS with review prompt ***
                |
                Agent evaluates its own output, may revise
                Agent calls exit_plan_mode with reviewCompleted: true
                |
                v
            Back to Section 4 (handleExitPlanModeTool)
            --> details.reviewCompleted is true
            --> runUserApproval directly (skip approval gate)
            --> user gets final say
```

---

## 6. Approval Result: #handleApprovalResult

```
#handleApprovalResult(slug, phase, path, content, approvedPhases, result, details)
    |
    v
result.approved?
    |
    |-- NO (not approved) -->
    |   |
    |   v
    |   result has "reason"?
    |   |-- YES --> reason text present?
    |   |   |-- YES --> onInputCallback(reason)
    |   |   |           *** AGENT RECEIVES: refinement/rejection feedback ***
    |   |   |           Agent revises and calls exit_plan_mode again
    |   |   |           --> back to Section 4
    |   |   |
    |   |   |-- NO  --> return (silent, nothing happens)
    |   |
    |   |-- NO  --> return (silent, Escape was pressed)
    |
    |-- YES (approved) -->
        |
        v
    writeWorkflowArtifact(cwd, slug, phase, content, approvedPhases)
        |   WRITES: docs/workflow/<slug>/<phase>.md    (artifact content)
        |   UPDATES: docs/workflow/<slug>/state.json
        |       - currentPhase = phase
        |       - artifacts[phase] = "docs/workflow/<slug>/<phase>.md"
        |       - activePhases = approvedPhases (if provided)
        |
        |-- FAILS --> showError("Failed to persist <phase> artifact: <error>") --> return
        |-- OK    --> continue
        v
    showStatus("<phase> phase approved and saved to docs/workflow/<slug>/<phase>.md")
        |
        v
    readWorkflowState(cwd, slug) to find next phase
    getNextPhase(state)
        |   Walks PHASES array from current position
        |   Respects activePhases filter (skips phases not in list)
        |
        v
    setActiveWorkflow(slug, nextPhase ?? phase, activePhases)
        |   Updates #activeWorkflowSlug, #activeWorkflowPhase, #activeWorkflowPhases
        |   Updates status bar
        |
        v
    planModeEnabled AND details.finalPlanFilePath?
        |-- YES --> #approvePlan(content, { planFilePath, finalPlanFilePath })
        |-- planModeEnabled only --> #exitPlanMode()
        |-- NO  --> continue
        v
    nextPhase exists?
        |
        |-- NO  --> return (workflow complete, no more phases)
        |
        |-- YES -->
            showHookSelector("<phase> approved. Continue to <nextPhase>?",
                ["Continue", "Stop here"])
            |
            *** USER SEES: Two-option selector ***
            |
            |-- "Continue" --> editor.setText("/workflow <nextPhase> <slug>")
            |                  *** Editor now contains the command for next phase ***
            |                  *** User presses Enter to start next phase ***
            |
            |-- "Stop here" --> return (editor stays empty)
            |
            |-- cancel (Escape) --> return (editor stays empty)
```

---

## 7. Starting Subsequent Phases (spec, design, plan, execute, verify, finish)

```
User presses Enter with "/workflow <phase> <slug>" in editor
    |   (or types it manually)
    |
    v
WorkflowCommand.execute(["<phase>", "<slug>"], ctx)
    |
    v
#start<Phase>(rest, ctx)
    |
    v
#resolveSlug(rest, ctx)
    |   rest[0] provided? --> use it
    |   else --> findActiveWorkflow(cwd)
    |       |-- .active file exists? --> read slug from it
    |       |-- else --> most recent workflow dir
    |       |-- none found?
    |           |-- ctx.hasUI? --> show input dialog --> user types slug
    |           |-- no UI?    --> return null --> error
    v
slug resolved?
    |-- NO  --> error "No workflow slug specified and no active workflow found."
    |-- YES --> continue
    v
#checkPrereq(ctx, slug, <prerequisite_phase>)
    |
    |   PREREQUISITE CHAIN:
    |   spec    requires: brainstorm
    |   design  requires: spec
    |   plan    requires: design (note: not spec)
    |   execute requires: plan
    |   verify  requires: execute (note: checks spec ref separately)
    |   finish  requires: verify
    |
    v
state.activePhases set?
    |-- YES --> prerequisite in activePhases?
    |   |-- NO  --> return false (prereq skipped, not needed)
    |   |-- YES --> must have artifact
    |-- NO  --> settings workflow.phases.<prereq>.enabled?
        |-- false --> return false (prereq disabled globally)
        |-- true  --> must have artifact
    v
readWorkflowArtifact(cwd, slug, prereq)
    |-- null (missing) --> error "Phase '<prereq>' has not been completed..." --> blocked
    |-- has content    --> return false (not blocked, continue)
    v
Read artifact references for prompt context:
    |
    |   ARTIFACT REFERENCES PER PHASE:
    |   spec:    brainstormRef
    |   design:  specRef, brainstormRef
    |   plan:    specRef, designRef
    |   execute: planRef, specRef, designRef
    |   verify:  specRef, planRef
    |   finish:  (slug only)
    |
    v
#populateLocalSetup(cwd, slug, [<prior_phases>])
    |   Returns a callback that writes prior artifacts as local:// files
    |   in the new session's artifacts directory
    |
    v
ctx.activateWorkflowPhase(slug, phase)
    |   Updates internal tracking
    |   Fire-and-forget: setActiveWorkflowSlug(cwd, slug)
    |
    v
ctx.newSession({ setup })
    |   Creates new agent session
    |   Calls setup callback to populate local:// files
    |
    v
renderPromptTemplate(<phasePrompt>, { workflowDir, slug, ...refs })
    |   Returns rendered prompt string
    |
    v
return prompt
    |   WorkflowCommand returns the prompt string
    |   session.prompt() submits it to the agent
    |
    v
Agent processes the phase prompt
    --> back to Section 3 (Agent Works on a Phase)
```

---

## 8. Management Commands

### `/workflow` (no subcommand)

```
/workflow
    |
    v
#showStatus(ctx) --> findActiveWorkflow(cwd)
    |-- no active workflow --> #showHelp(ctx) (usage text)
    |-- has active --> readWorkflowState --> formatWorkflowStatus --> notify
```

### `/workflow list`

```
/workflow list
    |
    v
listWorkflows(cwd) --> readdir docs/workflow/, filter dirs, sort reverse
    |-- empty --> notify "No workflows found"
    |-- has workflows -->
        ctx.hasUI?
        |-- YES --> showHookSelector with workflow options
        |   |       format: "<slug>  (<currentPhase>)"
        |   |-- user selects --> parse slug --> #showDetailedStatus
        |   |-- user cancels --> return
        |-- NO  --> format all as text --> #info
```

### `/workflow status [slug]`

```
/workflow status [slug]
    |
    v
#resolveSlug or findActiveWorkflow
    |-- no slug --> return false
    v
readWorkflowState
    |-- null --> return false
    v
Format each phase with markers:
    check mark = has artifact
    arrow      = current phase
    dot        = pending
Show activePhases info if set
```

### `/workflow resume [slug]`

```
/workflow resume [slug]
    |
    v
slug = rest[0] ?? findActiveWorkflow(cwd)
    |-- no slug --> error "No workflow slug specified..."
    v
readWorkflowState(cwd, slug)
    |-- null --> error "No state found..."
    v
getNextPhase(state)
    |-- null (all complete) --> info with formatWorkflowStatus
    |-- has nextPhase       --> #dispatchToPhase(nextPhase, slug, ctx)
                                (routes to #startSpec, #startDesign, etc.)
```

### `/workflow back [phase] [slug]`

```
/workflow back [phase] [slug]
    |
    v
#resolveSlug --> readWorkflowState
    |
    v
rest[0] is an explicit phase name?
    |-- YES --> use it (must be in PHASES list)
    |-- NO  --> find completed phases (have artifacts)
        |-- none completed --> error "No completed phases to go back to"
        |-- one completed  --> use it
        |-- multiple -->
            ctx.hasUI?
            |-- YES --> showHookSelector from completed phases
            |-- NO  --> error
    v
ctx.activateWorkflowPhase(slug, selectedPhase)
ctx.newSession({ setup })
return renderPromptTemplate(...)
```

### `/workflow skip <phase> [slug]`

```
/workflow skip <phase> [slug]
    |
    v
#resolveSlug
rest[0] is provided?
    |-- NO  --> error "Usage: /workflow skip <phase>"
    |-- YES --> validate phase in VALID_PHASES list
        |-- invalid --> error "Unknown phase..."
        v
    writeWorkflowArtifact(cwd, slug, phase, "(skipped)")
        |   WRITES: docs/workflow/<slug>/<phase>.md with "(skipped)"
        |   UPDATES: state.json
    info "Skipped <phase> phase for workflow '<slug>'"
```

### `/workflow abandon [slug]`

```
/workflow abandon [slug]
    |
    v
#resolveSlug --> readWorkflowState
    |-- null --> error "No state found..."
    v
state.status = "abandoned"
write updated state.json
setActiveWorkflowSlug(cwd, null) --> delete .active file
info "Workflow '<slug>' has been abandoned."
```

### `/workflow delete <slug>`

```
/workflow delete <slug>
    |
    v
#resolveSlug --> check dir exists
    |-- not exists --> error "No workflow found..."
    v
ctx.hasUI?
    |-- YES --> showHookSelector("Delete workflow '<slug>'?",
    |           ["Yes, delete", "Cancel"])
    |   |-- "Cancel" --> return
    |   |-- "Yes, delete" --> continue
    |-- NO  --> continue (no confirmation)
    v
rm -rf docs/workflow/<slug>/
getActiveWorkflowSlug(cwd) === slug? --> setActiveWorkflowSlug(cwd, null)
info "Deleted workflow '<slug>'"
```

### `/workflow rename <oldSlug> <newSlug>`

```
/workflow rename <oldSlug> <newSlug>
    |
    v
rest.length < 2? --> error "Usage: /workflow rename <old> <new>"
    v
oldDir exists? --> NO --> error "No workflow found for '<old>'"
    v
copy oldDir to newDir
update newDir/state.json: state.slug = newSlug
rm -rf oldDir
getActiveWorkflowSlug(cwd) === oldSlug? --> setActiveWorkflowSlug(cwd, newSlug)
info "Renamed workflow '<old>' to '<new>'"
```

### `/workflow switch [slug]`

```
/workflow switch [slug]
    |
    v
listWorkflows(cwd)
    |-- empty --> error "No workflows found"
    v
rest[0] provided?
    |-- YES --> use as slug
    |-- NO  -->
        ctx.hasUI?
        |-- YES --> showHookSelector with all workflows
        |   |       parse slug from "<slug>  (<phase>)" format
        |-- NO  --> error "Specify a slug..."
    v
setActiveWorkflowSlug(cwd, slug)
```

### `/workflow config`

```
/workflow config
    |
    v
ctx.hasUI?
    |-- NO  --> error "Use in interactive mode..."
    |-- YES --> ctx.ui.custom() --> WorkflowConfigComponent
        |
        |   Shows all 7 phases x 4 settings:
        |     - enabled (boolean)
        |     - approval (none/user/agent/both)
        |     - reviewAgent (critic/reviewer)
        |     - maxReviewRounds (1-5)
        |
        |   Keys: up/down navigate (wraps), Enter/Space cycle value,
        |          g toggle scope (session/global), r reset override,
        |          Escape close
```

---

## 9. Files Touched by the Workflow System

### Per-workflow files

```
docs/workflow/
    .active                          # Current active slug (text file)
    <slug>/
        state.json                   # { slug, currentPhase, artifacts, activePhases?, status? }
        brainstorm.md                # Phase artifact (written on approval)
        spec.md                      # Phase artifact
        design.md                    # Phase artifact
        plan.md                      # Phase artifact
        execute.md                   # Phase artifact
        verify.md                    # Phase artifact
        finish.md                    # Phase artifact
        learnings.md                 # Appended by persistPhaseLearnings (optional)
```

### Temporary files (during phase execution)

```
<artifactsDir>/local/                # Or <tmpdir>/omp-local/<sessionId>/local/
    BRAINSTORM.md                    # Agent writes here, read during approval
    SPEC.md                          # Same pattern for each phase
    DESIGN.md
    PLAN.md
    EXECUTE.md
    VERIFY.md
    FINISH.md
```

### Settings paths

```
workflow.phases.<phase>.approval         # "none" | "user" | "agent" | "both"
workflow.phases.<phase>.enabled          # boolean
workflow.phases.<phase>.reviewAgent      # "critic" | "reviewer"
workflow.phases.<phase>.maxReviewRounds  # 1-5 (default: 3)
```

---

## 10. Phase Dependency Graph

```
brainstorm (no prerequisites)
    |
    v
spec (requires: brainstorm)
    |   reads: brainstormRef
    v
design (requires: spec)
    |   reads: specRef, brainstormRef
    v
plan (requires: design)
    |   reads: specRef, designRef
    v
execute (requires: plan)
    |   reads: planRef, specRef, designRef
    v
verify (requires: execute)
    |   reads: specRef, planRef
    v
finish (requires: verify)
        reads: slug only
```

---

## 11. Event Flow: Tool Calls Routed by EventController

```
Agent calls a tool --> tool.execute() returns result
    |
    v
EventController receives tool_execution_end event
    |
    v
tool name?
    |
    |-- "exit_plan_mode" AND !isError AND details exists
    |       --> ctx.handleExitPlanModeTool(details)
    |
    |-- "propose_phases" AND !isError AND details exists
    |       --> ctx.setProposePhases(details)
    |       (stores { phases, rationale } for brainstorm approval)
    |
    |-- "start_workflow" AND !isError AND details exists
    |       --> ctx.handleStartWorkflowTool(details)
    |       (alternative entry: agent can start workflow via tool call)
    |
    |-- "switch_workflow" AND !isError AND details exists
    |       --> ctx.handleSwitchWorkflowTool(details)
    |
    |-- anything else --> normal tool result handling
    |
    |-- isError for any of above --> silently skipped (no user notification)
```

---

## 12. RPC Mode Differences

```
RPC mode (--mode rpc):
    |
    |-- No TUI -- all UI via extension_ui_request/response protocol
    |-- showHookSelector --> sends { type: "extension_ui_request", method: "select", ... }
    |   client responds: { type: "extension_ui_response", id, value: "Approve" }
    |-- showHookInput --> sends { type: "extension_ui_request", method: "input", ... }
    |   client responds: { type: "extension_ui_response", id, value: "user-input" }
    |-- notify --> sends { type: "extension_ui_request", method: "notify", ... }
    |   (fire-and-forget, no response expected)
    |
    |-- Workflow brainstorm: handled via rpc-workflow-handler
    |   (startWorkflow/activateWorkflowPhase wired separately)
    |
    |-- Phases that return prompt strings (spec, design, plan, etc.):
        work natively via session.prompt() returning the string
```
