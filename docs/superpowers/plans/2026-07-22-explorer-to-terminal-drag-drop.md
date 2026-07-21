# Explorer-to-Terminal Drag-and-Drop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag a file or directory from the file explorer and drop it onto a terminal pane, pasting the shell-quoted absolute path into the terminal input (no Enter).

**Architecture:** Extend the existing pointer-based `useExplorerDnd` hook to detect terminal panes (`data-pane-leaf`) as drop targets. When the pointer is over a terminal pane, set `useTerminalDropStore.targetLeafId` — the existing `DropOverlay` renders "Drop file path here". On pointerup, call `pasteIntoLeaf(leafId, formatDroppedPaths([source]))` for a bracketed paste. The `FileExplorer` component wires the callback.

**Tech Stack:** TypeScript, React, Zustand, xterm.js, vitest

## Global Constraints

- No new dependencies
- Paste without Enter (bracketed paste via xterm `term.paste()`)
- Absolute path (no relative-to-cwd computation)
- Single file/directory drag only (existing DnD tracks one source)
- Reuse existing infrastructure: `useTerminalDropStore`, `DropOverlay`, `pasteIntoLeaf`, `formatDroppedPaths`
- Terminal panes must be visible (`pointerEvents: auto`) to receive drops — hidden panes are skipped by `elementFromPoint()`

---

## File Structure

| File | Purpose |
| ------ | --------- |
| `src/modules/explorer/lib/useExplorerDnd.ts` | Add `resolveDropTarget` helper, terminal pane detection in `move`, `onDropToTerminal` callback in `end` |
| `src/modules/explorer/lib/useExplorerDnd.test.ts` | **New.** Unit tests for `resolveDropTarget` |
| `src/modules/explorer/FileExplorer.tsx` | Import `pasteIntoLeaf` + `formatDroppedPaths`, pass `onDropToTerminal` to `useExplorerDnd` |

---

### Task 1: `resolveDropTarget` helper + tests

**Files:**

- Create: `src/modules/explorer/lib/useExplorerDnd.test.ts`
- Modify: `src/modules/explorer/lib/useExplorerDnd.ts`

**Interfaces:**

- Produces: `resolveDropTarget(element: HTMLElement | null, rootPath: string, isDir: (p: string) => boolean | undefined): DropTarget` where `DropTarget = { kind: "terminal"; leafId: number } | { kind: "explorer"; dir: string } | null`

- [ ] **Step 1: Write the failing test**

Create `src/modules/explorer/lib/useExplorerDnd.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveDropTarget } from "./useExplorerDnd";

function mockElement(attrs: Record<string, string>): HTMLElement {
  const el = {
    closest: (selector: string) => {
      if (selector === "[data-pane-leaf]" && attrs["data-pane-leaf"]) return el;
      if (selector === "[data-fs-path]" && attrs["data-fs-path"]) return el;
      return null;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    dataset: attrs["data-pane-leaf"]
      ? { paneLeaf: attrs["data-pane-leaf"] }
      : {},
  } as unknown as HTMLElement;
  return el;
}

const isDir = (p: string) => p.endsWith("/");

describe("resolveDropTarget", () => {
  it("returns terminal target when element is inside a data-pane-leaf", () => {
    const el = mockElement({ "data-pane-leaf": "7" });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "terminal",
      leafId: 7,
    });
  });

  it("returns explorer target with directory path for a folder row", () => {
    const el = mockElement({ "data-fs-path": "/root/src/" });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "explorer",
      dir: "/root/src/",
    });
  });

  it("returns explorer target with parent dir for a file row", () => {
    const el = mockElement({ "data-fs-path": "/root/src/index.ts" });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "explorer",
      dir: "/root/src",
    });
  });

  it("returns null when element has no drop target attributes", () => {
    const el = mockElement({});
    expect(resolveDropTarget(el, "/root", isDir)).toBeNull();
  });

  it("returns null when element is null", () => {
    expect(resolveDropTarget(null, "/root", isDir)).toBeNull();
  });

  it("returns null when data-pane-leaf is not a finite number", () => {
    const el = mockElement({ "data-pane-leaf": "abc" });
    expect(resolveDropTarget(el, "/root", isDir)).toBeNull();
  });

  it("prioritizes terminal over explorer when both match (element is a pane-leaf)", () => {
    const el = mockElement({
      "data-pane-leaf": "3",
      "data-fs-path": "/root/foo",
    });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "terminal",
      leafId: 3,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/explorer/lib/useExplorerDnd.test.ts`
Expected: FAIL — `resolveDropTarget` is not exported

- [ ] **Step 3: Add `resolveDropTarget` + `DropTarget` type to `useExplorerDnd.ts`**

In `src/modules/explorer/lib/useExplorerDnd.ts`, add the type and function at the top of the file (after the existing imports and `parentDir` function):

```typescript
export type DropTarget =
  | { kind: "terminal"; leafId: number }
  | { kind: "explorer"; dir: string }
  | null;

export function resolveDropTarget(
  element: HTMLElement | null,
  rootPath: string,
  isDir: (p: string) => boolean | undefined,
): DropTarget {
  if (!element) return null;
  const leafEl = element.closest<HTMLElement>("[data-pane-leaf]");
  if (leafEl) {
    const leafId = Number(leafEl.dataset.paneLeaf);
    return Number.isFinite(leafId) ? { kind: "terminal", leafId } : null;
  }
  const row = element.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    return { kind: "explorer", dir: isDir(p) ? p : parentDir(p) };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/explorer/lib/useExplorerDnd.test.ts`
Expected: PASS — 7/7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/modules/explorer/lib/useExplorerDnd.ts src/modules/explorer/lib/useExplorerDnd.test.ts
git commit -m "feat: add resolveDropTarget helper for DnD target detection"
```

---

### Task 2: Wire terminal drop detection into `useExplorerDnd`

**Files:**

- Modify: `src/modules/explorer/lib/useExplorerDnd.ts`

**Interfaces:**

- Consumes: `resolveDropTarget` from Task 1, `useTerminalDropStore` from `@/modules/terminal/lib/dropStore`
- Produces: `useExplorerDnd` now accepts `onDropToTerminal?: (path: string, leafId: number) => void` in its `Options` and calls it on drop over a terminal pane

- [ ] **Step 1: Add the import and new option**

In `src/modules/explorer/lib/useExplorerDnd.ts`, add the import at the top:

```typescript
import { useTerminalDropStore } from "@/modules/terminal/lib/dropStore";
```

Add `onDropToTerminal` to the `Options` type:

```typescript
type Options = {
  rootPath: string;
  isDir: (path: string) => boolean | undefined;
  onMove: (from: string, toDir: string) => void;
  onDropToTerminal?: (path: string, leafId: number) => void;
};
```

- [ ] **Step 2: Add terminal target tracking ref**

Inside `useExplorerDnd`, after the existing `dropTargetRef`:

```typescript
const terminalTargetRef = useRef<number | null>(null);
```

Update `optsRef` to include `onDropToTerminal`:

```typescript
const optsRef = useRef({ rootPath, isDir, onMove, onDropToTerminal });
optsRef.current = { rootPath, isDir, onMove, onDropToTerminal };
```

- [ ] **Step 3: Replace the drop target logic in `move`**

In the `move` function, replace the existing block that finds the drop target:

```typescript
const { rootPath, isDir } = optsRef.current;
const hit = document
  .elementFromPoint(ev.clientX, ev.clientY)
  ?.closest<HTMLElement>("[data-fs-path]");
const p = hit?.getAttribute("data-fs-path");
const t = p ? (isDir(p) ? p : parentDir(p)) : rootPath;
const valid =
  t !== source && !t.startsWith(`${source}/`) && parentDir(source) !== t
    ? t
    : null;
if (dropTargetRef.current !== valid) {
  dropTargetRef.current = valid;
  setDropTargetDir(valid);
}
```

With:

```typescript
const { rootPath, isDir } = optsRef.current;
const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
const target = resolveDropTarget(el, rootPath, isDir);

if (target?.kind === "terminal") {
  if (terminalTargetRef.current !== target.leafId) {
    terminalTargetRef.current = target.leafId;
    dropTargetRef.current = null;
    setDropTargetDir(null);
    useTerminalDropStore.getState().setTarget(target.leafId);
  }
  return;
}

// Not over a terminal pane — clear terminal target
if (terminalTargetRef.current !== null) {
  terminalTargetRef.current = null;
  useTerminalDropStore.getState().setTarget(null);
}

// Existing explorer drop target logic
const p = el?.closest<HTMLElement>("[data-fs-path]")?.getAttribute("data-fs-path");
const t = p ? (isDir(p) ? p : parentDir(p)) : rootPath;
const valid =
  t !== source && !t.startsWith(`${source}/`) && parentDir(source) !== t
    ? t
    : null;
if (dropTargetRef.current !== valid) {
  dropTargetRef.current = valid;
  setDropTargetDir(valid);
}
```

- [ ] **Step 4: Update the `end` function**

In the `end` function, replace:

```typescript
if (commit && dropTargetRef.current)
  optsRef.current.onMove(source, dropTargetRef.current);
```

With:

```typescript
if (commit && terminalTargetRef.current !== null) {
  optsRef.current.onDropToTerminal?.(source, terminalTargetRef.current);
} else if (commit && dropTargetRef.current) {
  optsRef.current.onMove(source, dropTargetRef.current);
}
```

Then after the existing cleanup (after `setDropTargetDir(null)`), add:

```typescript
useTerminalDropStore.getState().setTarget(null);
terminalTargetRef.current = null;
```

- [ ] **Step 5: Clear terminal drop store on unmount**

The existing `useEffect` cleanup at the bottom of `useExplorerDnd` only calls `cleanupRef.current?.()` (which detaches event listeners). Since `useTerminalDropStore` is a global Zustand store, a stale `targetLeafId` would persist the `DropOverlay` if the explorer unmounts mid-drag. Update the cleanup:

Find:
```typescript
useEffect(() => () => cleanupRef.current?.(), []);
```

Replace with:
```typescript
useEffect(
  () => () => {
    cleanupRef.current?.();
    useTerminalDropStore.getState().setTarget(null);
  },
  [],
);
```

- [ ] **Step 6: Run typecheck to verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Run existing tests to verify no regression**

Run: `npx vitest run src/modules/explorer/lib/useExplorerDnd.test.ts`
Expected: 7/7 pass (from Task 1)

- [ ] **Step 8: Commit**

```bash
git add src/modules/explorer/lib/useExplorerDnd.ts
git commit -m "feat: wire terminal pane detection into useExplorerDnd"
```

---

### Task 3: Wire `onDropToTerminal` in `FileExplorer`

**Files:**

- Modify: `src/modules/explorer/FileExplorer.tsx`

**Interfaces:**

- Consumes: `onDropToTerminal` option from Task 2, `pasteIntoLeaf` from `@/modules/terminal/lib/rendererPool`, `formatDroppedPaths` from `@/modules/terminal/lib/quoteShellPath`
- Produces: functional end-to-end drag from explorer to terminal

- [ ] **Step 1: Add imports**

In `src/modules/explorer/FileExplorer.tsx`, add these imports near the top (with the other `@/modules/terminal` imports if any exist, or in the import block):

```typescript
import { pasteIntoLeaf } from "@/modules/terminal/lib/rendererPool";
import { formatDroppedPaths } from "@/modules/terminal/lib/quoteShellPath";
```

- [ ] **Step 2: Pass `onDropToTerminal` to `useExplorerDnd`**

Find the `useExplorerDnd` call (around line 271):

```typescript
const dnd = useExplorerDnd({
  rootPath: rootPath ?? "",
  isDir: isDirAt,
  onMove: tree.movePath,
});
```

Change to:

```typescript
const dnd = useExplorerDnd({
  rootPath: rootPath ?? "",
  isDir: isDirAt,
  onMove: tree.movePath,
  onDropToTerminal: (path, leafId) => {
    pasteIntoLeaf(leafId, formatDroppedPaths([path]));
  },
});
```

- [ ] **Step 3: Run typecheck to verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/modules/explorer/FileExplorer.tsx
git commit -m "feat: wire explorer-to-terminal drag-and-drop in FileExplorer"
```

---

### Task 4: Manual integration verification

**Files:**

- No file changes — manual verification only

- [ ] **Step 1: Verify drag from explorer to terminal**

1. Open Puhon with a project that has files
2. Open a terminal tab
3. Drag a file from the explorer toward the terminal pane
4. Verify: the `DropOverlay` appears on the terminal pane showing "Drop file path here"
5. Release the mouse over the terminal pane
6. Verify: the shell-quoted absolute path appears in the terminal input (no Enter sent)
7. Verify: the `DropOverlay` disappears after the drop

- [ ] **Step 2: Verify drag back to explorer still works**

1. Drag a file from the explorer to another folder in the explorer
2. Verify: the file moves to the new folder (existing behavior unchanged)

- [ ] **Step 3: Verify directory drag**

1. Drag a directory from the explorer to the terminal
2. Verify: the directory path appears in the terminal input

- [ ] **Step 4: Verify path with spaces**

1. Create a file with spaces in the name (e.g., `my file.txt`)
2. Drag it to the terminal
3. Verify: the path is shell-quoted (e.g., `/home/user/project/my file.txt` becomes `'/home/user/project/my file.txt'`)

- [ ] **Step 5: Verify no terminal tab open**

1. Close all terminal tabs (open only editor/preview tabs)
2. Drag a file from the explorer to the main area
3. Verify: no crash, no broken state — the drag just doesn't find a terminal target
