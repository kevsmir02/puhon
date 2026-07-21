# Explorer-to-Terminal Drag-and-Drop — Design

Date: 2026-07-22
Status: draft

## Goal

Let the user drag a file or directory from Puhon's file explorer and drop it onto a terminal pane, pasting the shell-quoted absolute path into the terminal input. Reframed as an agent-input affordance: the fastest way to feed a running agent (Codex, Claude Code, etc.) a file path is to drag it from the explorer into the terminal, review the pasted path, and press Enter.

## Existing Infrastructure

Three systems already in place make this a small change:

1. **Explorer pointer DnD** (`src/modules/explorer/lib/useExplorerDnd.ts`) — pointer-based drag for moving files within the explorer. Uses `document.elementFromPoint()` and `data-fs-path` attributes. Sidesteps native HTML5 DnD (Tauri intercepts it). Has a ghost element, 5px threshold, click suppression.

2. **Terminal OS file drop** (`src/modules/terminal/lib/useTerminalFileDrop.ts`) — handles OS file drops onto terminal panes via Tauri's `onDragDropEvent`. Finds the pane under the cursor via `data-pane-leaf` attribute, calls `pasteIntoLeaf(leafId, formatDroppedPaths(paths))`.

3. **Drop overlay** (`src/modules/terminal/PaneTreeView.tsx` → `DropOverlay`) — reads `useTerminalDropStore.targetLeafId` and renders "Drop file path here" on the matching pane. Already wired to every terminal leaf.

**Path quoting** (`src/modules/terminal/lib/quoteShellPath.ts`): `quoteShellPath(p)` quotes only when needed (safe chars pass through); `formatDroppedPaths(paths)` joins with spaces and trailing space.

**Paste** (`src/modules/terminal/lib/rendererPool.ts`): `pasteIntoLeaf(leafId, text)` calls `slot.term.paste(text)` — xterm bracketed paste. Agents that enabled bracketed paste (Claude Code) treat it as a real paste; a plain shell gets literal text. No Enter is sent.

## Architecture

Extend `useExplorerDnd` to recognize terminal panes as drop targets. The hook's `move` handler already runs globally on `window` via `pointermove` and calls `document.elementFromPoint()`. We add a `data-pane-leaf` check *before* the existing `data-fs-path` check:

```
pointer down on explorer row (data-fs-path)
  │
  ▼
pointermove (global)
  │
  ├─ elementFromPoint has data-pane-leaf?
  │   YES → set useTerminalDropStore.targetLeafId = leafId
  │         clear explorer drop target
  │         (DropOverlay renders "Drop file path here")
  │
  │   NO  → clear terminal target
  │         existing logic: find data-fs-path → explorer drop target
  │
  ▼
pointerup
  ├─ terminal target set? → onDropToTerminal(source, leafId)
  │                         → pasteIntoLeaf(leafId, formatDroppedPaths([source]))
  │
  └─ explorer target set? → onMove(source, dir)  [existing behavior]
```

## Components

### 1. `useExplorerDnd` — extended

**File:** `src/modules/explorer/lib/useExplorerDnd.ts`

Add to `Options`:
```typescript
onDropToTerminal?: (path: string, leafId: number) => void;
```

Add a `terminalTargetRef` (`useRef<number | null>(null)`) alongside the existing `dropTargetRef`.

In the `move` function, before the `data-fs-path` lookup:
```typescript
const leafEl = document
  .elementFromPoint(ev.clientX, ev.clientY)
  ?.closest<HTMLElement>("[data-pane-leaf]");
if (leafEl) {
  const leafId = Number(leafEl.dataset.paneLeaf);
  if (Number.isFinite(leafId) && terminalTargetRef.current !== leafId) {
    terminalTargetRef.current = leafId;
    dropTargetRef.current = null;
    setDropTargetDir(null);
    useTerminalDropStore.getState().setTarget(leafId);
  }
  return;
}
// Not over a terminal pane — clear terminal target, proceed with explorer logic
if (terminalTargetRef.current !== null) {
  terminalTargetRef.current = null;
  useTerminalDropStore.getState().setTarget(null);
}
// ... existing data-fs-path drop target logic ...
```

In the `end` function:
```typescript
const end = (commit: boolean) => {
  detach();
  if (!active) return;
  if (commit && terminalTargetRef.current !== null) {
    optsRef.current.onDropToTerminal?.(source, terminalTargetRef.current);
  } else if (commit && dropTargetRef.current) {
    optsRef.current.onMove(source, dropTargetRef.current);
  }
  // ... existing cleanup: suppressClick, clear refs, setDragLabel(null), setDropTargetDir(null) ...
  useTerminalDropStore.getState().setTarget(null);
  terminalTargetRef.current = null;
};
```

Import `useTerminalDropStore` from `@/modules/terminal/lib/dropStore`.

### 2. `FileExplorer` — wire the callback

**File:** `src/modules/explorer/FileExplorer.tsx`

Import `pasteIntoLeaf` and `formatDroppedPaths`:
```typescript
import { pasteIntoLeaf } from "@/modules/terminal/lib/rendererPool";
import { formatDroppedPaths } from "@/modules/terminal/lib/quoteShellPath";
```

Pass the callback to `useExplorerDnd`:
```typescript
const { ghostRef, dragLabel, dropTargetDir, onPointerDown, onClickCapture } =
  useExplorerDnd({
    rootPath: rootPath ?? "",
    isDir,
    onMove: movePath,
    onDropToTerminal: (path, leafId) => {
      pasteIntoLeaf(leafId, formatDroppedPaths([path]));
    },
  });
```

### No changes needed

- `PaneTreeView.tsx` / `DropOverlay` — already renders from `useTerminalDropStore`
- `quoteShellPath.ts` — already shell-quotes correctly
- `rendererPool.ts` / `pasteIntoLeaf` — already does bracketed paste
- `dropStore.ts` / `useTerminalDropStore` — already has `setTarget`
- `useTerminalFileDrop.ts` — OS drops continue to work independently

## Data flow

```
1. User pointer-downs on explorer row with data-fs-path="/home/user/project/src/index.ts"
2. Pointer moves > 5px threshold → drag activates, ghost shows "index.ts"
3. Pointer moves over terminal pane (data-pane-leaf="7")
4. move handler: elementFromPoint → closest [data-pane-leaf] → leafId=7
5. useTerminalDropStore.setTarget(7) → DropOverlay renders "Drop file path here" on pane 7
6. User releases pointer (pointerup) over pane 7
7. end handler: terminalTargetRef.current=7, calls onDropToTerminal("/home/user/project/src/index.ts", 7)
8. FileExplorer callback: pasteIntoLeaf(7, formatDroppedPaths(["/home/user/project/src/index.ts"]))
9. formatDroppedPaths → "/home/user/project/src/index.ts " (trailing space, no quoting needed for safe path)
10. pasteIntoLeaf → slot.term.paste(text) → bracketed paste into xterm
11. useTerminalDropStore.setTarget(null) → DropOverlay disappears
12. User reviews pasted path, presses Enter when ready
```

## Edge cases

| Scenario | Behavior |
| --- | --- |
| Drag from terminal pane back to explorer | Terminal target clears, explorer target takes over. `DropOverlay` disappears, explorer row highlight appears. |
| Drag to empty space (no valid target) | Both targets clear. On release, nothing happens. Ghost disappears. |
| Hidden terminal panes (non-active tab) | `pointerEvents: none` + `visibility: hidden` → `elementFromPoint()` skips them. Can only drop onto visible panes. |
| Block-mode terminal (Claude Code) | `pasteIntoLeaf` uses xterm bracketed paste. Block-mode terminals handle it correctly — path appears in input, no submit. |
| Directory drag | Works — `formatDroppedPaths` quotes the path the same way. Terminal receives directory path. |
| Single file only | The existing DnD tracks one `source` path. Multi-select drag is not supported by the current system. Out of scope. |
| No terminal tab open | No `data-pane-leaf` elements visible. Drag falls back to explorer-only behavior. No crash. |
| Path with spaces/special chars | `quoteShellPath` quotes only when needed. Safe chars pass through verbatim; spaces/special chars get shell-quoted. |
| Component unmount during drag | `cleanupRef` detach + `useTerminalDropStore.setTarget(null)` in cleanup. No stale overlay. |

## Lifecycle

| Event | Action |
| --- | --- |
| Pointer-down on explorer row | Start tracking (existing) |
| Pointer moves > 5px threshold | Activate drag, show ghost (existing) |
| Pointer over terminal pane | Set `targetLeafId` in drop store, show `DropOverlay` |
| Pointer over explorer row | Clear terminal target, set explorer drop target (existing) |
| Pointerup over terminal pane | `pasteIntoLeaf` with quoted path, clear overlay |
| Pointerup over explorer folder | `onMove` (existing behavior) |
| Pointerup on invalid target | No action (existing behavior) |
| Pointercancel / unmount | Clear all targets and overlay |

## Testing

- **Unit test:** `useExplorerDnd` with a mocked `elementFromPoint` returning a `data-pane-leaf` element — verifies `onDropToTerminal` is called with the correct path and leafId, and that `useTerminalDropStore.targetLeafId` is set/cleared.
- **Unit test:** Transition from terminal target back to explorer target — verifies terminal target clears and explorer target takes over.
- **Manual test:** Drag a file from the explorer to a terminal pane, verify the quoted path appears in the terminal input, verify `DropOverlay` shows during drag and disappears on drop.

## Files changed

| File | Change |
| --- | --- |
| `src/modules/explorer/lib/useExplorerDnd.ts` | Add terminal pane detection in `move`, `onDropToTerminal` callback in `end`, import `useTerminalDropStore` |
| `src/modules/explorer/FileExplorer.tsx` | Import `pasteIntoLeaf` + `formatDroppedPaths`, pass `onDropToTerminal` to `useExplorerDnd` |

## Out of scope

- Multi-select drag (the DnD system tracks a single source path)
- Relative path computation (absolute paths are simpler and always correct)
- Dragging from explorer search results (search result rows don't have `data-fs-path` — separate concern)
- Submitting with Enter (paste without Enter is safer for agent input; user presses Enter when ready)
- Dragging from other sources (editor tabs, git history) — only explorer rows initiate this drag
