# Taskbar/Status Bar Architecture for Workflow Features

## Current Components

### 1. FooterComponent (`packages/coding-agent/src/modes/components/footer.ts`)
- Displays: pwd, git branch, token stats (↑↓RC), billing ($), context usage (%), model name, thinking level
- Receives data from: AgentSession
- Located: Bottom of editor (below hook statuses line)
- Customization: `setExtensionStatus()` allows extensions to add status text

### 2. StatusLineComponent (`packages/coding-agent/src/modes/components/status-line.ts`)
- **Main UI component for status display**
- Renders to: **Editor's top border** (not main viewport)
- Mounted in: InteractiveMode.ui (added as child component at line 334)
- Integration point: `updateEditorTopBorder()` called from interactive-mode (lines 378, 383, 490, 611, 1220)

**Data Flow:**
1. InteractiveMode.#updatePlanModeStatus() → calls statusLine.setPlanModeStatus()
2. statusLine.getTopBorder(width) → called by updateEditorTopBorder()
3. editor.setTopBorder(topBorder) → renders above editor content

### 3. Plan Mode State Tracking

**PlanModeState** (`packages/coding-agent/src/plan-mode/state.ts`):
```typescript
interface PlanModeState {
  enabled: boolean;
  planFilePath: string;
  workflow?: "parallel" | "iterative";
  reentry?: boolean;
  workflowSlug?: string;  // ← For workflow switching
}
```

**Data passed to UI:**
- InteractiveMode calls `session.setPlanModeState(PlanModeState)`
- Currently only `enabled` and `paused` flags surface to UI (see #updatePlanModeStatus at line 589-612)
- Missing: workflowSlug is stored in PlanModeState but NOT passed to status line

### 4. SegmentContext (Data Model for Status Line Rendering)
Location: `packages/coding-agent/src/modes/components/status-line/types.ts` (lines 18-52)

```typescript
planMode: {
  enabled: boolean;
  paused: boolean;
  autoMode?: boolean;           // NOT YET SET
  stage?: string;               // NOT YET SET
  stageIndex?: number;          // NOT YET SET
  totalStages?: number;         // NOT YET SET
  readOnly?: boolean;
}
```

**CURRENT GAP**: planMode object in SegmentContext has no workflowSlug or currentPhase field.

### 5. Segments Available
- `plan_mode` segment (lines 77-109 in segments.ts) — renders "Plan" / "Plan ⏸" / "Auto" / "Read-Only"
- Displays stage progress if stage/stageIndex/totalStages set: "Plan: brainstorm 1/7"
- Colors: accent (normal), warning (paused/read-only)

## Call Chain

1. `InteractiveMode.#enterPlanMode()` (line 631)
   → `session.setPlanModeState({ enabled: true, planFilePath, workflow, reentry, workflowSlug? })`
   → `#updatePlanModeStatus()` (line 608)
   → `statusLine.setPlanModeStatus(status)`
   → `updateEditorTopBorder()` (line 611)
   → `statusLine.getTopBorder(width)` (builds segments)
   → `renderSegment('plan_mode', ctx)` reads `ctx.planMode`

2. Status line renders in editor's top border—always visible

## TUI Structure
- StatusLineComponent is NOT a TUI Component (doesn't implement standard Component interface for tui-viewport)
- Renders string output directly (calls theme functions for colors/icons)
- Integrated via editor's top border mechanism (not a standard TUI component slot)

## What Needs to Be Updated

1. **SegmentContext.planMode** — add `workflowSlug?: string` and `currentPhase?: string`
2. **StatusLineComponent.setPlanModeStatus()** signature — accept workflow slug and phase info
3. **InteractiveMode.#updatePlanModeStatus()** — extract workflowSlug from session.getPlanModeState()
4. **planModeSegment render logic** — display slug + phase if available
