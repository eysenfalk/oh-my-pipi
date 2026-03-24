# TUI Component System Analysis for Workflow Config Panel Design

## 1. Available TUI Component Types

Core components exported from `packages/tui/src/`:

### Container/Layout Components
- **Container** - Basic component aggregator that vertically concatenates children's render output
  - Methods: `addChild()`, `removeChild()`, `clear()`, `invalidate()`, `render()`
  - Children rendered without spacing/borders - used purely for vertical stacking
  
- **Box** - Container with padding and optional background
  - Constructor: `Box(paddingX=1, paddingY=1, bgFn?)`
  - Applies uniform padding and background to all children
  - Caches rendered output for performance

### Text/Display Components
- **Text** - Multi-line text with word wrapping
  - Constructor: `Text(text, paddingX=1, paddingY=1, customBgFn?)`
  - Supports ANSI codes, auto-wraps at word boundaries
  - Caches output keyed by text content + width

- **Markdown** - Renders markdown with syntax highlighting
  - Supports headings, code blocks, lists, quotes, links, tables
  - Theme functions for each element type
  - Optional mermaid diagram support

- **TruncatedText** - Single-line text with ellipsis support

### Input/Selection Components
- **SettingsList** - Vertical menu for setting/toggling values
  - Items: `{id, label, currentValue, description?, values?, submenu?}`
  - Values displayed on right side
  - Arrow keys navigate, Enter/Space to activate
  - Can cycle through discrete values OR open submenu for complex changes
  - No native support for inline editing - complex changes use submenus

- **SelectList** - Vertical selection list with filtering
  - Items: `{value, label, description?, hint?}`
  - Up/Down/PageUp/PageDown navigation
  - Enter to select, Escape to cancel
  - Supports filtering with `setFilter()`

- **Input** - Single-line text input
  - Extends Text, implements Focusable
  - Full edit operations: backspace, word delete, kill-ring, undo
  - Emacs-style keybindings: Ctrl+A, Ctrl+E, Ctrl+W, Ctrl+Y, Ctrl+_
  - Bracketed paste mode support

- **Editor** - Multi-line code editor
  - Syntax highlighting support
  - Line numbers, word wrapping
  - Full navigation + edit operations
  - Implements Focusable

- **TabBar** - Horizontal tab switcher
  - Items: `{id, label}`
  - Tab/Shift+Tab to cycle
  - Callback on tab change

### Status/Feedback Components
- **Loader** - Animated spinner with message
  - Animates every 80ms with braille spinner
  - Requires TUI instance for requestRender()

- **CancellableLoader** - Loader with "press esc to cancel" hint

- **Image** - Renders images using terminal protocol (kitty/sixel)

- **Spacer** - Renders N empty lines

## 2. SettingsList Item Types and Toggle/Number Rendering

### Item Definition
```typescript
interface SettingItem {
  id: string;           // Unique identifier
  label: string;        // Left-side label text
  description?: string; // Shown below selected item
  currentValue: string; // Right-side value display (always string)
  values?: string[];    // If provided, cycled through on Enter/Space
  submenu?: (currentValue: string, done: (newValue?: string) => void) => Component;
}
```

### Boolean Rendering Pattern
- Booleans are represented as `"true"` / `"false"` strings
- Single value cycle: Enter/Space toggles between the two
- Example: `values: ["true", "false"]` → cycles on Enter
- onChange callback receives string value, checked with `=== "true"`

### Number Rendering Pattern
- Numbers rendered as string in currentValue
- Cannot directly increment/decrement with SettingsList
- Must use submenu for complex number input:
  ```typescript
  submenu: (currentValue, done) => {
    const input = new Input();
    input.setValue(currentValue);
    input.onSubmit = (val) => done(val);
    return input;
  }
  ```

### Theme Application
SettingsList uses `SettingsListTheme`:
- `label(text, isSelected)` → colors left side
- `value(text, isSelected)` → colors right side
- `description(text)` → colors description below
- `cursor` → prefix character (e.g., "→")
- `hint(text)` → scroll info and help text

## 3. Custom Component Focus and Keyboard Handling

### Focus Model
Custom components created via `ctx.ui.custom()` receive focus automatically:

```typescript
async showHookCustom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void
  ) => Component | Promise<Component>,
  options?: { overlay?: boolean }
): Promise<T>
```

### Keyboard Handling
1. Component receives raw keycodes via `handleInput(data: string)`
2. Use helper: `matchesKey(data, "keyName")` to match named keys
3. Available key names: "up", "down", "enter", "escape", "esc", "ctrl+c", "pageUp", "pageDown", "tab", etc.
4. Set `wantsKeyRelease?: true` on component interface to receive key release events

### Focus/Rendering Lifecycle
1. Component placed in editor container: `ctx.editorContainer.addChild(component)`
2. Focus set: `ctx.ui.setFocus(component)`
3. Component should call `tui.requestRender()` after state changes
4. When done, call `done(result)` to close and restore editor
5. Optional cleanup: implement `dispose?()` method

### Focusable Interface (IME Support)
If component needs text cursor position for IME:
```typescript
export interface Focusable {
  focused: boolean;  // Set by TUI
}
```
- Emit `CURSOR_MARKER` constant in render output at cursor position
- TUI will find marker and position hardware cursor there

## 4. Container Grouping/Sections Support

### Grouping Mechanism
Container does NOT have native section/group support. Grouping achieved via composition:

**Pattern 1: Headers + Spacers**
```typescript
const container = new Container();
container.addChild(new Text(theme.bold("Section Title"), 0, 0));
container.addChild(new Spacer(1));
container.addChild(settingsList1);
container.addChild(new Spacer(2));
container.addChild(new Text(theme.bold("Section 2"), 0, 0));
container.addChild(new Spacer(1));
container.addChild(settingsList2);
```

**Pattern 2: Box with Background**
```typescript
const section = new Box(1, 1, t => theme.bg("sectionBg", t));
section.addChild(new Text(title, 0, 0));
section.addChild(settingsList);
container.addChild(section);
```

**Pattern 3: Custom Renderer Class**
```typescript
class Section implements Component {
  constructor(title: string, child: Component) {}
  render(width: number) {
    // Render title with separator
    // Render child with indentation
  }
}
```

### Key Limitation
- All children of Container/Box render consecutively with no gap
- No native tabs/multi-pane support in Container
- TabBar exists for switching panels (manage separately)

## Design Implications for Workflow Config Panel

### Suitable Architecture
- Use TabBar for "Global Settings" | "Session Overrides" tabs
- Under each tab: Container with grouped settings
- Use Box() for visual grouping of phases/categories
- Each phase (brainstorm, spec, etc.) can be a SettingsList with 3 items:
  1. Auto mode: `{"true", "false"}` cycled
  2. Critic enabled: `{"true", "false"}` cycled
  3. Critic rounds: submenu with Input component

### Not Suitable
- Nested SettingsLists (no tree hierarchy)
- Inline number editing without submenu
- Multiple selection (SettingsList is single-selection)
- Custom separators between items (use Spacer + header Text)
