# Oh My Pi Project Overview

## Purpose
AI coding agent for terminal. Monorepo with packages for agent core, AI provider integrations, TUI, and utilities.

## Tech Stack
- Runtime: Bun (no build step, `omp` symlink is live at repo source)
- Language: TypeScript + Rust (minimal, for performance)
- Type Checker: biome + tsgo (`bun check:ts`)
- Test: bun:test (`bun test`)

## Code Style & Conventions (AGENTS.md)
- Private fields: `#` syntax (no `private` keyword)
- Imports: namespace node imports (e.g., `import * as fs from "node:fs"`)
- No `console.log`, no `ReturnType<>`, no `any` (unless necessary)
- Prompts: stored in `.md` files with `with { type: "text" }` import
- Barrel files: `export *` pattern

## Key Directories
- `packages/agent/` - Agent core loop and hooks
- `packages/ai/` - Provider integrations (Anthropic, OpenAI, Google, etc.)
- `packages/coding-agent/` - Terminal agent, session management, slash commands
- `packages/tui/` - Terminal UI
- `packages/utils/` - Shared utilities

## Testing & Verification
- Run: `bun test <path>`
- Check types: `bun check:ts` (runs biome + tsgo)
- Format: `bun fmt` (biome + cargo)
- Lint: `bun lint` (biome + clippy)

## Critical Context: Compression Pipeline & Anthropic Constraints
- **Compression wiring**: AgentSession#transformContext → applyContextPruning → converts AgentMessage[] (never modifies Message[])
- **Thinking block rule**: Latest assistant message's thinking/redactedThinking blocks must remain structurally identical (cryptographically signed by Anthropic)
- **Message alternation**: Anthropic API requires alternating user/assistant roles; consecutive same-role messages violate this
- **Convert function**: `convertAnthropicMessages()` in `packages/ai/src/providers/anthropic.ts` transforms AgentMessage[] → MessageParam[]
