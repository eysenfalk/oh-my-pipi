# Terminal Interface Analysis for TUI E2E Testing

## Overview
The OMP TUI package uses a `Terminal` interface to abstract terminal operations. This allows both real terminal (ProcessTerminal) and test implementations (VirtualTerminal for testing).

## Terminal Interface Definition

The `Terminal` interface is defined in `packages/tui/src/terminal.ts` with these methods and properties:

### Initialization & Lifecycle
- `start(onInput: (data: string) => void, onResize: () => void): void` - Start terminal, set up handlers
- `stop(): void` - Stop terminal, restore state
- `drainInput(maxMs?: number, idleMs?: number): Promise<void>` - Drain stdin before exiting (prevents key release leaks)

### Output Methods
- `write(data: string): void` - Write raw ANSI escape sequences or text
- `hideCursor(): void` - Hide terminal cursor (writes `\x1b[?25l`)
- `showCursor(): void` - Show terminal cursor (writes `\x1b[?25h`)
- `clearLine(): void` - Clear current line (writes `\x1b[K`)
- `clearFromCursor(): void` - Clear from cursor to end of screen (writes `\x1b[J`)
- `clearScreen(): void` - Clear entire screen and move cursor to (1,1) (writes `\x1b[H\x1b[0J`)
- `setTitle(title: string): void` - Set terminal window title via OSC (writes `\x1b]0;{title}\x07`)
- `moveBy(lines: number): void` - Move cursor up (negative) or down (positive) by N lines (writes `\x1b[{n}A` or `\x1b[{n}B`)

### State Properties (Getters)
- `columns: number` - Get current terminal width
- `rows: number` - Get current terminal height
- `kittyProtocolActive: boolean` - Whether Kitty keyboard protocol is active
- `appearance: TerminalAppearance | undefined` - Detected dark/light mode (detected via OSC 11)

### Event Handlers
- `onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void` - Register callback for dark/light mode changes

## Input Events

The terminal receives raw ANSI escape sequences and text input via the `onInput` callback:
- Regular characters: `"a"`, `"1"`, `" "` (space), etc.
- Arrow keys: `"\x1b[A"` (up), `"\x1b[B"` (down), `"\x1b[C"` (right), `"\x1b[D"` (left)
- Escape sequences: All keys are eventually parsed into standard or Kitty protocol sequences
- With Kitty protocol: Keys arrive as `\x1b[codepoint;modifiers;eventTypeu` format
- Bracketed paste: `\x1b[200~{paste_content}\x1b[201~` when pasting

Key handling uses `matchesKey(data, "key+modifiers")` to match patterns like:
- `"ctrl+c"`, `"shift+enter"`, `"alt+a"`, `"cmd+k"`, etc.
- Functions: `"f1"` through `"f12"`, `"enter"`, `"tab"`, `"backspace"`, etc.

## Resize Events

Terminal emits a resize event via the `onResize` callback when terminal dimensions change.
- TUI should call `requestRender()` on resize
- Access new dimensions via `terminal.columns` and `terminal.rows`

## ProcessTerminal Implementation Details

### Features:
- Queries Kitty keyboard protocol support via `\x1b[?u` and enables with `\x1b[>7u`
- Falls back to modifyOtherKeys if Kitty unavailable: `\x1b[>4;2m`
- Queries terminal background color via OSC 11: `\x1b]11;?\x07`
- Uses DA1 sentinel to avoid hangs: `\x1b[c` after OSC 11
- Supports Mode 2031 for push-based appearance changes: `\x1b[?2031h`
- On Windows: enables ENABLE_VIRTUAL_TERMINAL_INPUT for proper escape sequences
- Enables bracketed paste mode: `\x1b[?2004h`
- Configurable write logging via `PI_TUI_WRITE_LOG` environment variable

### Error Handling:
- Catches write failures and marks terminal as dead (no recovery)
- Ignores restore errors during shutdown

## How TUI Uses Terminal

The `TUI` class (main rendering engine) uses terminal as follows:

### Methods Called (from grep analysis):
1. `terminal.start(onInputHandler, onResizeHandler)` - Initialize and set up handlers
2. `terminal.hideCursor()` - Hide cursor before rendering
3. `terminal.columns` and `terminal.rows` - Get viewport dimensions
4. `terminal.write(ansiData)` - Write rendered output and ANSI sequences
5. `terminal.showCursor()` - Show cursor after rendering (when focused component exists)
6. `terminal.stop()` - Cleanup on shutdown
7. Query methods: `terminal.write("\x1b[c")` for device attributes
8. `terminal.write("\x1b[16t")` for cell size queries
9. Movement: `terminal.write(\`\x1b[${n}B\`)` for cursor positioning

### Rendering Flow:
1. TUI receives input via `onInput` callback
2. Input is parsed and forwarded to focused component
3. Component handles input and may call `tui.requestRender()`
4. TUI renders all visible components to strings
5. TUI uses differential rendering (only writes changed lines)
6. Output is combined and written to terminal via `terminal.write()`

### Keyboard Input Flow:
1. Terminal receives raw stdin data
2. StdinBuffer parses it into individual sequences
3. Terminal calls `onInput` callback with each sequence
4. TUI forwards to focused component's `handleInput()` method
5. Components use `matchesKey(data, keySpec)` to identify keys

## Existing Test Terminal

### VirtualTerminal (test implementation)
Location: `packages/tui/test/virtual-terminal.ts`

Implements full Terminal interface using xterm.js for accurate emulation:
- Full ANSI escape sequence support
- Proper viewport/scrollback buffer management
- Test-specific methods:
  - `sendInput(data: string)` - Simulate keyboard input
  - `resize(cols, rows)` - Simulate resize event
  - `flush()` - Wait for async writes
  - `flushAndGetViewport()` - Get visible screen content
  - `getViewport()` - Get current viewport as string array
  - `getScrollBuffer()` - Get entire buffer history
  - `clear()` / `reset()` - Clear terminal state

### Usage Pattern in Tests:
```typescript
const terminal = new VirtualTerminal(80, 24);
const tui = new TUI(terminal);
// Add components and setup...
tui.start();
terminal.sendInput("\x1b[A"); // Simulate up arrow
await terminal.flushAndGetViewport(); // Get rendered output
```

## Creation Pattern

Interactive mode creates TUI+Terminal like this:
```typescript
// packages/coding-agent/src/modes/interactive-mode.ts line 216
this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
```

Then later:
```typescript
this.ui.start(); // Starts the terminal
```

## Key Types & Patterns

- **TerminalAppearance**: `"dark" | "light"`
- **Component**: Has `render(width)`, optional `handleInput(data)`, optional `invalidate()`, optional `wantsKeyRelease` property
- **Focusable**: Component that implements `focused` property for IME cursor positioning
- **InputListener**: Middleware for intercepting input before components see it
- **OverlayOptions**: For modal/dialog positioning and sizing

## What TestTerminal Needs to Support

To build an E2E test framework, TestTerminal should:
1. Implement full Terminal interface
2. Support input simulation: `sendInput()` method
3. Support dimension changes: `resize()` method
4. Support output capture: viewport/buffer access
5. Support async flushing for consistent test state
6. Use xterm.js or similar for accurate ANSI emulation
7. Allow assertion on rendered output vs expected state
