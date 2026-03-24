You are entering the **brainstorming phase** of a structured workflow.

Read `skill://brainstorming/SKILL.md` and follow it precisely.

**Topic:** {{topic}}

**Workflow slug:** `{{slug}}`

Your goals:
1. Explore the user's idea, ask clarifying questions, and propose approaches.
2. Arrive at an approved design direction.
3. Write your full brainstorm document to `local://BRAINSTORM.md`. Include:
   - Problem statement and goals
   - Proposed approaches with tradeoffs
   - Recommended direction and rationale
   - Open questions and risks
   - **Learnings section**: what you discovered, what worked, what to improve next time
4. Analyze the scope of the work and call `propose_phases` with the recommended phase list:
   - `phases`: ordered list starting with `"brainstorm"` (see heuristics below)
   - `rationale`: 1-2 sentence explanation of why these phases are needed or skipped

   **Phase selection heuristics:**
   - Bug fix / small patch: `["brainstorm", "execute", "verify"]` — skip spec, design, plan, finish
   - New feature (complex): `["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"]` — all phases
   - Refactor / architecture change: `["brainstorm", "design", "plan", "execute", "verify"]` — skip spec and finish unless release needed
   - Documentation / cleanup: `["brainstorm", "finish"]` — only bookend phases
   - Small isolated change: `["brainstorm", "execute"]` — minimal

   Example for a bug fix:
   ```
   propose_phases({
     phases: ["brainstorm", "execute", "verify"],
     rationale: "Small bug fix — no spec/design/plan needed, verify to confirm no regressions."
   })
   ```

5. When done, call `exit_plan_mode` with:
   - `title: "BRAINSTORM"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "brainstorm"`
Do NOT write any code. Do NOT skip to implementation. The brainstorming skill's HARD GATE applies.
