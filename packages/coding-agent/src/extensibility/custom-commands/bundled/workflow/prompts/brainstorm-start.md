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
4. When done, call `exit_plan_mode` with:
   - `title: "BRAINSTORM"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "brainstorm"`

Do NOT write any code. Do NOT skip to implementation. The brainstorming skill's HARD GATE applies.
