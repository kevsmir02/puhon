# Remove AI and LSP Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip all AI features (chat, agents, tools, autocomplete, model config, agent detection) and all LSP features from Terax while preserving the terminal-based IDE core.

**Architecture:** Delete ~99 files across 7 directories, modify ~37 files. A critical prerequisite is relocating `native.ts` (Tauri IPC wrappers — not AI-specific) out of the AI module before deleting it. The plan proceeds in dependency order: relocate shared utils → delete AI/LSP code → clean integration points → update deps → verify.

**Tech Stack:** TypeScript, React, Tauri (Rust), Vite, pnpm

**Spec:** `docs/superpowers/specs/2025-07-17-remove-ai-lsp-design.md`

## Global Constraints

- `pnpm tsc --noEmit` must pass with zero errors before any commit
- `cargo build` in `src-tauri/` must pass before any commit
- All existing non-AI functionality must remain intact
- Commit after each task with a descriptive message

---

### Task 1: Relocate `native.ts` to shared location

**Files:**

- Create: `src/lib/native.ts` (copy from `src/modules/ai/lib/native.ts`)
- Modify: `src/modules/ai/lib/native.ts` (delete original)
- Modify: 13 consumer files to update import paths

**Interfaces:**

- Produces: `src/lib/native.ts` exports `native` object and all utility types (ReadResult, DirEntry, CommandOutput, GrepHit, GrepResponse, GlobHit, GlobResponse, GitRepoInfo, GitChangedFile, GitStatusSnapshot, GitDiffResult, GitDiffContentResult, GitCommitResult, GitPushResult, GitLogEntry, GitCommitFileChange, GitPanelSnapshot, GitDiscardEntry, GitBranchEntry, GitBranchListResult)

- [ ] **Step 1: Copy native.ts to shared location**

```bash
cp src/modules/ai/lib/native.ts src/lib/native.ts
```

- [ ] **Step 2: Update import in copied file**

The copied file imports `currentWorkspaceEnv` from `@/modules/workspace`. This path is still valid from `src/lib/`. Verify the file has no other internal AI-module dependencies:

```bash
rg "from \"\." src/lib/native.ts
```

Expected: no output (no relative imports)

- [ ] **Step 3: Update all consumer import paths**

Replace `from "@/modules/ai/lib/native"` with `from "@/lib/native"` in each file:

```bash
# Files that import native from the ai module:
rg -l "from \"@/modules/ai/lib/native\"" src/ --glob "*.ts" --glob "*.tsx"
```

For each file, replace the import. The files are:

- `src/app/App.tsx`
- `src/modules/git-history/GitHistoryPane.tsx`
- `src/modules/git-history/lib/graph.ts`
- `src/modules/source-control/SourceControlPanel.tsx`
- `src/modules/source-control/useSourceControl.ts`
- `src/modules/source-control/useSourceControlContext.ts`
- `src/modules/source-control/useSourceControlPanel.ts`
- `src/modules/spaces/lib/useSpacesBoot.ts`
- `src/modules/statusbar/StatusBar.tsx`
- `src/app/components/WorkspaceInputBar.tsx`
- `src/app/components/useGitBranch.ts`
- `src/modules/explorer/FileExplorer.tsx`
- `src/modules/explorer/lib/gitStatusUtils.ts`

Example replacement:

```typescript
// Before:
import { native } from "@/modules/ai/lib/native";
// After:
import { native } from "@/lib/native";
```

- [ ] **Step 4: Verify compilation**

```bash
pnpm tsc --noEmit
```

Expected: zero errors. If there are errors, they must be fixed before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/lib/native.ts
git add -u  # stages the modified import paths
git commit -m "refactor: relocate native.ts from ai module to shared src/lib"
```

---

### Task 2: Extract `markdown-code.tsx` to markdown module

**Files:**

- Create: `src/modules/markdown/lib/markdown-code.tsx`
- Modify: `src/modules/markdown/MarkdownPreviewPane.tsx`

**Interfaces:**

- Produces: `src/modules/markdown/lib/markdown-code.tsx` exports `MarkdownCode` component and `markdownCodeText` helper

- [ ] **Step 1: Copy markdown-code and fix imports**

```bash
cp src/components/ai-elements/markdown-code.tsx src/modules/markdown/lib/markdown-code.tsx
```

The copied file imports from `./chat-code`. We need to inline or adapt this.

Read `src/components/ai-elements/chat-code.tsx` — it's the Lezer-based syntax highlighting block. Since we're removing `ai-elements/`, we need to extract `ChatCodeBlock` as well, or simplify the markdown renderer.

Check what `ChatCodeBlock` is:

```bash
rg "export.*ChatCodeBlock" src/components/ai-elements/chat-code.tsx
```

The `ChatCodeBlock` component is a Lezer-highlighted code block. Extract it alongside the markdown renderer:

```bash
# Create a standalone code block renderer for markdown
```

Actually, let's simplify: copy `ChatCodeBlock` logic into the markdown module. Read the source:

```bash
cat src/components/ai-elements/chat-code.tsx
```

Then create a self-contained `src/modules/markdown/lib/markdown-code.tsx` that includes the Lezer highlighting inline.

- [ ] **Step 2: Rewrite the markdown-code file to be self-contained**

The new `src/modules/markdown/lib/markdown-code.tsx` should combine `markdown-code.tsx` and `chat-code.tsx` from `ai-elements/`, removing any dependencies on `context.tsx` or other AI elements. The `ChatCodeBlock` uses `useLezerHighlight` from `chat-code-lezer.ts` — that utility should also be extracted.

Better approach: extract all three files (`chat-code-lezer.ts`, `chat-code.tsx`, `markdown-code.tsx`) into `src/modules/markdown/lib/` as they form a self-contained code-highlighting utility with no AI dependencies.

```bash
cp src/components/ai-elements/chat-code-lezer.ts src/modules/markdown/lib/chat-code-lezer.ts
cp src/components/ai-elements/chat-code.tsx src/modules/markdown/lib/chat-code.tsx
cp src/components/ai-elements/markdown-code.tsx src/modules/markdown/lib/markdown-code.tsx
```

Update internal imports in all three files: replace `from "./chat-code"` → `from "./chat-code"` (already relative, stays the same), and any reference to context/other ai-elements.

- [ ] **Step 3: Update MarkdownPreviewPane.tsx**

```typescript
// Before:
import { MarkdownCode } from "@/components/ai-elements/markdown-code";
// After:
import { MarkdownCode } from "../lib/markdown-code";
```

- [ ] **Step 4: Verify compilation**

```bash
pnpm tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/markdown/lib/chat-code-lezer.ts src/modules/markdown/lib/chat-code.tsx src/modules/markdown/lib/markdown-code.tsx
git add src/modules/markdown/MarkdownPreviewPane.tsx
git commit -m "refactor: extract markdown code renderer from ai-elements"
```

---

### Task 3: Delete AI and LSP directories and standalone files

**Files:**

- Delete: 7 directories and ~15 individual files (see list below)
- The build will break — this is expected. Subsequent tasks fix it.

- [ ] **Step 1: Delete AI/LSP directories**

```bash
rm -rf src/modules/ai/
rm -rf src/components/ai-elements/
rm -rf src/modules/agents/
rm -rf src/modules/lsp/
rm -rf src/modules/editor/lib/autocomplete/
rm -rf src-tauri/src/modules/lsp/
```

- [ ] **Step 2: Delete standalone frontend files**

```bash
rm src/modules/editor/AiDiffPane.tsx
rm src/modules/editor/AiDiffStack.tsx
rm src/modules/editor/AiDiffStackLazy.tsx
rm src/settings/sections/ModelsSection.tsx
rm src/settings/sections/AgentsSection.tsx
rm src/settings/components/ProviderKeyCard.tsx
rm src/settings/components/ProviderIcon.tsx
rm src/settings/components/LspServersGroup.tsx
rm src/modules/terminal/lib/agentActivity.ts
rm src/modules/terminal/lib/agentActivity.test.ts
rm src/modules/tabs/AgentTabBadge.tsx
rm src/modules/statusbar/DiagnosticsBadge.tsx
```

- [ ] **Step 3: Delete Rust backend files**

```bash
rm src-tauri/src/modules/agent.rs
rm src-tauri/src/modules/pty/agent_detect.rs
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete AI and LSP modules (~99 files)"
```

**The build is broken at this point.** Remaining tasks fix the integration points.

---

### Task 4: Clean tab system (`useTabs.ts`, `TabBar.tsx`, `editor/index.ts`)

**Files:**

- Modify: `src/modules/tabs/lib/useTabs.ts` (remove AiDiffTab, openAiDiffTab, closeAiDiffTab, setAiDiffStatus, newAgentTab)
- Modify: `src/modules/tabs/TabBar.tsx` (remove ai-diff tab rendering)
- Modify: `src/modules/editor/index.ts` (remove AiDiffStack re-export)

- [ ] **Step 1: Remove AiDiffTab types and related functions from useTabs.ts**

In `src/modules/tabs/lib/useTabs.ts`:

Remove `AiDiffStatus` type (line ~72):

```typescript
// DELETE these lines:
export type AiDiffStatus = "pending" | "approved" | "rejected";
```

Remove `AiDiffTab` type (lines ~74-84):

```typescript
// DELETE:
export type AiDiffTab = TabBase & {
  kind: "ai-diff";
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};
```

Remove `ai-diff` from the `Tab` union type (line ~122):

```typescript
// Before:
  | AiDiffTab
// After: (remove this line)
```

Remove `newAgentTab` function (lines ~449-466):

```typescript
// DELETE the entire function
const newAgentTab = useCallback((cwd: string | undefined, title: string) => {
  ...
}, []);
```

Remove `openAiDiffTab` function (lines ~585-625):

```typescript
// DELETE the entire function
const openAiDiffTab = useCallback(...);
```

Remove `setAiDiffStatus` function (lines ~627-639):

```typescript
// DELETE the entire function
const setAiDiffStatus = useCallback(...);
```

Remove `closeAiDiffTab` function (lines ~640-670):

```typescript
// DELETE the entire function
const closeAiDiffTab = useCallback(...);
```

- [ ] **Step 2: Remove ai-diff tab rendering from TabBar.tsx**

Find the ai-diff case in `TabBar.tsx` (around line 654):

```typescript
// DELETE the ai-diff branch in the tab content switch/render:
if (tab.kind === "ai-diff") {
  // ... delete entire block
}
```

- [ ] **Step 3: Remove AiDiffStack re-export from editor/index.ts**

```typescript
// Before:
export { AiDiffStack } from "./AiDiffStackLazy";
// After: remove this line
```

- [ ] **Step 4: Verify compilation**

```bash
pnpm tsc --noEmit
```

Fix any errors from stale references in non-AI files. Expected: errors only from App.tsx, EditorPane.tsx, settings, and other files cleaned in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove AI diff tabs and agent tab from tab system"
```

---

### Task 5: Clean editor (`EditorPane.tsx`, `extensions.ts`, `externalFormat.ts`, `useDocument.ts`)

**Files:**

- Modify: `src/modules/editor/EditorPane.tsx`
- Modify: `src/modules/editor/lib/extensions.ts`
- Modify: `src/modules/editor/lib/externalFormat.ts`
- Modify: `src/modules/editor/lib/useDocument.ts`

- [ ] **Step 1: Remove LSP and AI imports from EditorPane.tsx**

Delete these import lines:

```typescript
// DELETE:
import { endpointIdFromCompatModel } from "@/modules/ai/config";
import { getCustomEndpointKey, getKey } from "@/modules/ai/lib/keyring";
import { lspFormatDocument, useLspExtension } from "@/modules/lsp";
```

- [ ] **Step 2: Remove LSP extension and format-on-save from EditorPane.tsx**

Remove `lspCompartment` import from extensions (used on line ~285):

```typescript
// In the extension setup, remove the lspCompartment line
// Before:
lspCompartment.of([]),
// After: (remove this configuration line)
```

Remove `useLspExtension` hook call (around line 373):

```typescript
// DELETE:
const lspExt = useLspExtension(path, langId, doc.status === "ready");
lspActiveRef.current = lspExt !== null;

// DELETE the compartment reconfigure effect:
useEffect(() => {
  ...
  effects: lspCompartment.reconfigure(lspExt ?? []),
}, [lspExt]);
```

Remove LSP format-on-save path (around lines 178-210):

```typescript
// DELETE the entire LSP format block from the save handler
// Keep only the external formatter path
```

Remove `triggerAiComplete` prop and its wiring.

Remove the provider/key resolution for autocomplete in format/save flows.

- [ ] **Step 3: Remove `lspCompartment` from extensions.ts**

```typescript
// DELETE:
export const lspCompartment = new Compartment();
```

- [ ] **Step 4: Remove "lsp" from externalFormat.ts**

```typescript
// Before:
export type EditorFormatter =
  | "lsp"    // DELETE this line
  | "biome"
  ...

// DELETE the "lsp" entry from formatter labels:
lsp: "Language server",  // DELETE
```

Update fallback logic: find where `global === "lsp"` is used as fallback and change to `"prettier"` or `null`.

- [ ] **Step 5: Remove notifyDocumentSaved from useDocument.ts**

```typescript
// DELETE:
import { notifyDocumentSaved } from "@/modules/lsp";

// DELETE the `notifyDocumentSaved(path)` call in the save handler
```

- [ ] **Step 6: Verify compilation**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove LSP and AI references from editor"
```

---

### Task 6: Clean `App.tsx`

**Files:**

- Modify: `src/app/App.tsx`

This is the largest single-file change. Use the exact approach below.

- [ ] **Step 1: Remove AI/LSP imports**

Delete these import lines:

```typescript
// DELETE lines ~14-26:
AgentNotificationsBridge,
AgentRunBridge,
AiMiniWindow,
LocalAgentNotificationsBridge,
SelectionAskAi,
useAiBootstrap,
useAiLiveBridge,
useSelectionAskAi,
// DELETE line ~27:
import { AiComposerProvider } from "@/modules/ai/lib/composer";
// DELETE line ~43:
import { setLspNavigator } from "@/modules/lsp";
```

- [ ] **Step 2: Remove AI hooks and state from component body**

Remove these hooks/callbacks (found at lines ~305, 493, 1141):

```typescript
// DELETE:
const { hasComposer, keysLoaded } = useAiBootstrap();
const { askPopup, setAskPopup, onAskFromSelection } = useSelectionAskAi({...});
useAiLiveBridge({...});
```

Remove `respondToApproval`:

```typescript
// DELETE:
const respondToApproval = useChatStore((s) => s.respondToApproval);
```

Remove `togglePanelAndFocus` and related:

```typescript
// DELETE:
const togglePanelAndFocus = useCallback(() => { ... }, []);
```

Remove `handleAttachFileToAgent`:

```typescript
// DELETE the entire callback:
const handleAttachFileToAgent = useCallback(...);
```

Remove `askFromSelection`:

```typescript
// DELETE:
const askFromSelection = useCallback(() => { ... }, []);
```

Remove `activateAgentTarget`:

```typescript
// DELETE the entire callback
const activateAgentTarget = useCallback(...);
```

- [ ] **Step 3: Remove AI keyboard shortcuts**

Remove from the shortcut handler (~738-790):

```typescript
// DELETE these cases:
"ai.toggle": togglePanelAndFocus,
"ai.toggleMini": () => { ... },
"ai.askSelection": askFromSelection,
"agent.focusAttention": () => { ... },
"editor.aiComplete": () => editorRefs.current.get(activeId)?.triggerAiComplete(),
```

Remove from shortcut filter:

```typescript
// DELETE the check for "editor.aiComplete" and "ai.askSelection"
```

- [ ] **Step 4: Remove AI/LSP JSX**

Delete these JSX elements:

```typescript
// DELETE <AiMiniWindow state={miniPresence.state} />
// DELETE <SelectionAskAi ... />
// DELETE <AgentNotificationsBridge ... />
// DELETE <AgentRunBridge ... />
// DELETE <LocalAgentNotificationsBridge />
```

- [ ] **Step 5: Remove AiComposerProvider wrapper**

```typescript
// Before:
return <AiComposerProvider>{shell}</AiComposerProvider>;
// After:
return shell;
```

- [ ] **Step 6: Remove AI-related props from child components**

Remove from `<SidebarRail>`: `toggleAi`, `askAiSelection`
Remove from `<EditorStack>`: `onAiDiffAccept`, `onAiDiffReject`
Remove from `<FileExplorer>`: `onAttachToAgent`
Remove from `<WorkspaceSurface>`: `onOpenAi`
Remove from `<TabBar>`: `openAiDiffTab`, `closeAiDiffTab`, `newAgentTab`

- [ ] **Step 7: Remove `setLspNavigator` call**

```typescript
// DELETE:
setLspNavigator({ openFile: openContentHit });
return () => setLspNavigator(null);
```

- [ ] **Step 8: Remove `onActivateAgent` and `onActivateLocalAgent`**

Remove from state and props.

- [ ] **Step 9: Verify compilation**

```bash
pnpm tsc --noEmit
```

Fix any remaining errors from stale variable references.

- [ ] **Step 10: Commit**

```bash
git add src/app/App.tsx
git commit -m "refactor: remove all AI and LSP integration from App"
```

---

### Task 7: Clean settings (`store.ts`, `EditorSection.tsx`, `SettingsApp.tsx`)

**Files:**

- Modify: `src/modules/settings/store.ts`
- Modify: `src/settings/sections/EditorSection.tsx`
- Modify: `src/settings/SettingsApp.tsx`

- [ ] **Step 1: Remove AI/LSP imports from settings store.ts**

```typescript
// DELETE lines 1-16:
import {
  type AutocompleteProviderId,
  type CustomEndpoint,
  DEFAULT_AUTOCOMPLETE_MODEL,
  DEFAULT_MODEL_ID,
  DEFAULT_STT_PROVIDER,
  isKnownModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  type ModelId,
  migrateLegacyCompatEndpoint,
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  type SttProvider,
  WHISPERCPP_DEFAULT_BASE_URL,
} from "@/modules/ai/config";
```

- [ ] **Step 2: Remove AI/LSP preference keys from Preferences type**

Delete these fields from the `Preferences` type:

```typescript
// DELETE:
defaultModelId: ModelId;
customInstructions: string;
autocompleteEnabled: boolean;
autocompleteTrigger: AutocompleteTrigger;
autocompleteProvider: AutocompleteProviderId;
autocompleteModelId: string;
lmstudioBaseURL: string;
lmstudioModelId: string;
mlxBaseURL: string;
mlxModelId: string;
ollamaBaseURL: string;
ollamaModelId: string;
openaiCompatibleBaseURL: string;
openaiCompatibleModelId: string;
openaiCompatibleContextLimit: number;
customEndpoints: CustomEndpoint[];
openrouterModelId: string;
sttProvider: SttProvider;
groqSttModel: string;
whispercppBaseURL: string;
favoriteModelIds: string[];
recentModelIds: string[];
agentNotifications: boolean;
lspActivation: Record<string, LspActivation>;
lspCustomServers: LspCustomServer[];
```

- [ ] **Step 3: Remove related type definitions**

```typescript
// DELETE:
export type AutocompleteTrigger = "auto" | "manual";
export type LspActivation = "enabled" | "dismissed";
export type LspCustomServer = { ... };
```

- [ ] **Step 4: Remove related preference keys and constants**

Delete all the key constants for removed prefs:

```typescript
// DELETE these keys:
KEY_DEFAULT_MODEL, KEY_CUSTOM_INSTRUCTIONS,
KEY_AUTOCOMPLETE_ENABLED, KEY_AUTOCOMPLETE_TRIGGER,
KEY_AUTOCOMPLETE_PROVIDER, KEY_AUTOCOMPLETE_MODEL,
KEY_LMSTUDIO_BASE_URL, KEY_LMSTUDIO_MODEL_ID,
KEY_MLX_BASE_URL, KEY_MLX_MODEL_ID,
KEY_OLLAMA_BASE_URL, KEY_OLLAMA_MODEL_ID,
KEY_OPENAI_COMPAT_BASE_URL, KEY_OPENAI_COMPAT_MODEL_ID,
KEY_OPENAI_COMPAT_CONTEXT_LIMIT,
KEY_CUSTOM_ENDPOINTS, KEY_OPENROUTER_MODEL_ID,
KEY_STT_PROVIDER, KEY_GROQ_STT_MODEL, KEY_WHISPERCPP_BASE_URL,
KEY_FAVORITE_MODELS, KEY_RECENT_MODELS,
KEY_AGENT_NOTIFICATIONS,
KEY_LSP_ACTIVATION, KEY_LSP_CUSTOM_SERVERS,
```

- [ ] **Step 5: Remove removed fields from DEFAULT_PREFERENCES**

Delete the corresponding entries in `DEFAULT_PREFERENCES`.

- [ ] **Step 6: Remove removed fields from loadPreferences()**

Delete the getter lines for each removed preference.

- [ ] **Step 7: Remove setLspActivation and setLspCustomServers functions**

Delete these two exported functions.

- [ ] **Step 8: Change editorFormatter default from "lsp" to "prettier"**

```typescript
// Before:
editorFormatter: "lsp",
// After:
editorFormatter: "prettier",
```

- [ ] **Step 9: Remove "lsp" from EditorFormatter type**

```typescript
// Before:
| "lsp"
// After: remove this line
```

- [ ] **Step 10: Clean EditorSection.tsx**

Remove the LspServersGroup import and JSX, remove "lsp" from formatter dropdown.

- [ ] **Step 11: Clean SettingsApp.tsx**

Remove ModelsSection and AgentsSection imports and nav entries.

- [ ] **Step 12: Verify compilation**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor: remove AI and LSP preferences from settings"
```

---

### Task 8: Clean remaining frontend integration files

**Files:**

- Modify: `src/modules/header/Header.tsx`
- Modify: `src/modules/terminal/block/BlockOverlay.tsx`
- Modify: `src/modules/explorer/FileExplorer.tsx`
- Modify: `src/modules/shortcuts/shortcuts.ts`
- Modify: `src/modules/editor/lib/diffCache.ts`

- [ ] **Step 1: Clean Header.tsx**

Remove the agents import (NotificationBell from `@/modules/agents`) and its JSX usage.

- [ ] **Step 2: Clean BlockOverlay.tsx**

Remove `useChatStore` import and usage.

- [ ] **Step 3: Clean FileExplorer.tsx**

Remove `onAttachToAgent` prop and the "Attach to Agent" context menu action.

- [ ] **Step 4: Clean shortcuts.ts**

Remove AI shortcuts:

```typescript
// DELETE these shortcut definitions:
"ai.toggle"
"ai.toggleMini"
"ai.askSelection"
"agent.focusAttention"
"editor.aiComplete"
```

- [ ] **Step 5: Check diffCache.ts**

If it imported from `@/modules/ai` (for native.ts), update the import to `@/lib/native`.

- [ ] **Step 6: Verify compilation**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: clean remaining AI references from frontend"
```

---

### Task 9: Clean Rust backend

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/modules/mod.rs`
- Modify: `src-tauri/src/modules/pty/mod.rs`
- Modify: `src-tauri/src/modules/pty/session.rs`
- Modify: `src-tauri/src/modules/shell/mod.rs` (if agent references exist)

- [ ] **Step 1: Remove agent and lsp from module imports in lib.rs**

```rust
// Before (line 3):
use modules::{agent, fs, git, history, lsp, net, pty, secrets, shell, workspace};
// After:
use modules::{fs, git, history, net, pty, secrets, shell, workspace};
```

- [ ] **Step 2: Remove __terax_notify handler in lib.rs**

Remove the block at lines ~160-169:

```rust
// DELETE:
if args.get(1).map(String::as_str) == Some("__terax_notify") {
    if let (Some(agent), Some(event)) = (args.get(2), args.get(3)) {
        agent::emit_conout_marker(agent, event);
    }
    // ... exit
}
```

- [ ] **Step 3: Remove LspState management in lib.rs**

```rust
// DELETE:
.manage(lsp::LspState::default())
```

- [ ] **Step 4: Remove LSP and agent Tauri commands in lib.rs**

Delete these from the `generate_handler!` macro:

```rust
// DELETE:
lsp::lsp_detect,
lsp::lsp_host_pid,
lsp::lsp_resolve_root,
lsp::lsp_spawn,
lsp::lsp_send,
lsp::lsp_kill,
agent::agent_enable_hooks,
agent::agent_hooks_status,
```

- [ ] **Step 5: Remove LSP kill-on-exit in lib.rs**

```rust
// DELETE the block at ~329:
tauri::RunEvent::Exit => {
    if let Some(state) = app.try_state::<lsp::LspState>() {
        state.kill_all();
    }
}
```

- [ ] **Step 6: Clean modules/mod.rs**

```rust
// DELETE:
pub mod agent;
pub mod lsp;
```

- [ ] **Step 7: Clean pty/mod.rs**

```rust
// DELETE:
mod agent_detect;
```

- [ ] **Step 8: Clean pty/session.rs**

Remove the `use super::agent_detect::AgentDetector;` import.

Remove the AgentDetector usage in the PTY read loop:

```rust
// DELETE:
let mut agent_detect = AgentDetector::new();
// ... and the process/finish calls in the read loop
```

- [ ] **Step 9: Check shell/mod.rs for agent references**

```bash
rg "agent" src-tauri/src/modules/shell/
```

If any agent references exist, remove them.

- [ ] **Step 10: Verify Rust compilation**

```bash
cd src-tauri && cargo build 2>&1
```

Expected: zero errors, zero warnings.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: remove agent and LSP modules from Rust backend"
```

---

### Task 10: Update dependencies and build config

**Files:**

- Modify: `package.json`
- Modify: `vite.config.ts`
- Regenerate: `pnpm-lock.yaml`

- [ ] **Step 1: Remove AI SDK dependencies from package.json**

Delete these lines from `dependencies`:

```json
"@ai-sdk/anthropic": "^3.0.94",
"@ai-sdk/cerebras": "^2.0.57",
"@ai-sdk/google": "^3.0.83",
"@ai-sdk/groq": "^3.0.42",
"@ai-sdk/openai": "^3.0.81",
"@ai-sdk/openai-compatible": "^2.0.51",
"@ai-sdk/react": "^3.0.209",
"@ai-sdk/xai": "^3.0.103",
"ai": "^6.0.207",
```

- [ ] **Step 2: Remove AI SDK chunk-splitting from vite.config.ts**

Delete lines ~93-103:

```typescript
// DELETE:
if (id.includes("@ai-sdk/anthropic")) return "ai-anthropic";
if (id.includes("@ai-sdk/google")) return "ai-google";
if (id.includes("@ai-sdk/openai-compatible")) return "ai-openai-compat";
if (id.includes("@ai-sdk/openai")) return "ai-openai";
if (id.includes("@ai-sdk/cerebras")) return "ai-cerebras";
if (id.includes("@ai-sdk/groq")) return "ai-groq";
if (id.includes("@ai-sdk/xai")) return "ai-xai";
if (id.includes("@ai-sdk/")) return "ai-sdk-shared";
```

- [ ] **Step 3: Regenerate lockfile**

```bash
pnpm install
```

- [ ] **Step 4: Verify full build**

```bash
pnpm tsc --noEmit
pnpm build
```

Expected: zero errors, clean build.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vite.config.ts
git commit -m "chore: remove AI SDK dependencies and build config"
```

---

### Task 11: Final verification

**Files:**

- No new changes — verification only.

- [ ] **Step 1: TypeScript compilation**

```bash
pnpm tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Vite production build**

```bash
pnpm build
```

Expected: successful bundle with no AI/LSP chunks.

- [ ] **Step 3: Rust compilation**

```bash
cd src-tauri && cargo build 2>&1
```

Expected: zero errors, zero warnings.

- [ ] **Step 4: Check for leftover references**

```bash
# No file should reference the deleted modules:
rg "from \"@/modules/ai" src/ --glob "*.ts" --glob "*.tsx" && echo "FAIL" || echo "PASS"
rg "from \"@/modules/lsp" src/ --glob "*.ts" --glob "*.tsx" && echo "FAIL" || echo "PASS"
rg "from \"@/modules/agents" src/ --glob "*.ts" --glob "*.tsx" && echo "FAIL" || echo "PASS"
rg "from \"@/components/ai-elements" src/ --glob "*.ts" --glob "*.tsx" && echo "FAIL" || echo "PASS"
```

Expected: all four return PASS (no matches).

- [ ] **Step 5: Run existing tests**

```bash
pnpm vitest run
```

Expected: all remaining tests pass (AI/LSP tests were deleted).

- [ ] **Step 6: Commit final verification**

```bash
git commit --allow-empty -m "verify: clean TypeScript+Rust build after AI/LSP removal"
```
