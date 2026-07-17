# Remove AI and LSP Features — Design Spec

**Status:** Approved
**Date:** 2025-07-17

## Goal

Strip all AI features (chat, agents, tools, autocomplete, model config, agent detection) and all LSP features (language server integration, diagnostics, format-on-save via LSP) from Terax. The result is a pure terminal-based IDE: file explorer, editor (syntax highlighting only), terminal/PTY, source control, git history, markdown preview, web preview, themes, spaces, command palette, and settings.

## Rationale

The user uses external CLI harnesses (OpenCode, Pi Coding Agent) that already provide AI and LSP capabilities. Terax's value is its terminal-based IDE shell — not its AI integration. Removing these features eliminates ~25% of the codebase, simplifies future development, and removes heavy dependencies (`ai`, 7 `@ai-sdk/*` packages).

---

## Section 1: Files to Delete

### 1.1. Entire directories

| Directory | Files | Purpose |
| --- | --- | --- |
| `src/modules/ai/` | ~45 | Chat runtime, agents, tools, stores, hooks, config, keyring, transport, security, prompt, compact, composer, sessions, snippets, todos, slash commands, plan store, todo store, snippets store, model prefs, proxy fetch, redact, STT, mini window geometry |
| `src/components/ai-elements/` | ~10 | Chat rendering: conversation, message, reasoning, tool, chat-code, chat-code-lezer, shimmer, snippet, markdown-code, context |
| `src/modules/agents/` | ~12 | Agent notification system: notifications bridge, notification bell, toast, store, route, review, format, types, window focus hook |
| `src/modules/lsp/` | ~13 | LSP frontend: client, session manager, transport, presets, runtime store, protocol shim, locations panel, navigator, detect, URI utils, LSP extension hook, LSP hint hook, LspStatusPill |
| `src/modules/editor/lib/autocomplete/` | ~5 | Inline AI ghost text: inlineExtension, provider, prompt, normalizeIndent, trimSuggestion |
| `src-tauri/src/modules/lsp/` | ~5 | LSP backend: mod, session, framing, env, rss |

### 1.2. Individual frontend files

| File | Reason |
| --- | --- |
| `src/modules/editor/AiDiffPane.tsx` | AI diff rendering |
| `src/modules/editor/AiDiffStack.tsx` | AI diff stack |
| `src/modules/editor/AiDiffStackLazy.tsx` | Lazy wrapper for AI diff stack |
| `src/settings/sections/ModelsSection.tsx` | Model/provider configuration UI (47KB) |
| `src/settings/sections/AgentsSection.tsx` | Agent configuration UI (18KB) |
| `src/settings/components/ProviderKeyCard.tsx` | API key input card |
| `src/settings/components/ProviderIcon.tsx` | Provider icon component |
| `src/settings/components/LspServersGroup.tsx` | LSP server configuration |
| `src/modules/terminal/lib/agentActivity.ts` | Agent activity detection in terminal |
| `src/modules/terminal/lib/agentActivity.test.ts` | Agent activity tests |

### 1.3. Individual Rust backend files

| File | Reason |
| --- | --- |
| `src-tauri/src/modules/agent.rs` | Agent hook management (Claude/Codex/Gemini) |
| `src-tauri/src/modules/pty/agent_detect.rs` | Agent OSC sequence detection |

### 1.4. AI-related test files

Any test file whose subject module is being deleted (e.g., `src/modules/ai/config.test.ts`, `src/modules/ai/lib/errors.test.ts`, `src/modules/ai/lib/miniWindowGeometry.test.ts`, `src/modules/ai/lib/prompt.test.ts`, `src/modules/ai/lib/security.test.ts`, `src/modules/ai/tools/search.test.ts`).

---

## Section 2: Files to Modify

### 2.1. Heavy modifications

#### `src/app/App.tsx`

Remove:

- **Imports:** `AgentNotificationsBridge`, `AgentRunBridge`, `AiMiniWindow`, `LocalAgentNotificationsBridge`, `SelectionAskAi`, `useAiBootstrap`, `useAiLiveBridge`, `useSelectionAskAi` from `@/modules/ai`; `AiComposerProvider` from `@/modules/ai/lib/composer`; `setLspNavigator` from `@/modules/lsp`; `native` from `@/modules/ai/lib/native`
- **State/hooks:** `useAiBootstrap()` call; `useSelectionAskAi()` call; `useAiLiveBridge()` call; `respondToApproval`; `togglePanelAndFocus`; `askFromSelection`; `handleAttachFileToAgent`; `activateAgentTarget`; `newAgentTab`; `openAiDiffTab`; `closeAiDiffTab`; `onActivateAgent`; `onActivateLocalAgent`; `setLspNavigator(…)`
- **Keyboard shortcuts:** `ai.toggle`, `ai.toggleMini`, `ai.askSelection`, `agent.focusAttention`, `editor.aiComplete`
- **JSX:** `<AiMiniWindow>`, `<SelectionAskAi>`, `<AgentNotificationsBridge>`, `<AgentRunBridge>`, `<LocalAgentNotificationsBridge>`
- **Wrapper:** `<AiComposerProvider>` — children become direct return value
- **Props passed down:** `onAttachToAgent`, `onAiDiffAccept`, `onAiDiffReject`, `onOpenAi`, `openAiDiffTab`, `closeAiDiffTab`, `newAgentTab`, `toggleAi`, `askAiSelection`

Keep:

- Shell initialization, editor refs, tab system, workspace switching, theme, shortcuts (non-AI), sidebar, file drop, close guards

#### `src/modules/editor/EditorPane.tsx`

Remove:

- `import { endpointIdFromCompatModel } from "@/modules/ai/config"` and `import { getCustomEndpointKey, getKey } from "@/modules/ai/lib/keyring"`
- `import { lspFormatDocument, useLspExtension } from "@/modules/lsp"`
- `triggerAiComplete` prop and the logic that fires it
- `lspCompartment` usage (imported from `extensions.ts`)
- `useLspExtension()` hook call and `lspActiveRef` / `warnedNoLspRef`
- LSP format-on-save path in the save callback
- Provider/key resolution for autocomplete in format/save flows

Keep:

- External formatter support (prettier, biome, etc.)
- Manual format via keyboard shortcut
- Template literal provider path (if it just resolves model names for non-AI use — if it was autocomplete-only, remove that too)

#### `src/modules/tabs/lib/useTabs.ts`

Remove:

- `AiDiffStatus` type, `AiDiffTab` type
- `ai-diff` union member from `Tab`
- `openAiDiffTab()`, `closeAiDiffTab()`, `setAiDiffStatus()`, `newAgentTab()`
- Agent-read-only terminal flag if driven solely by agent context

Keep:

- All other tab kinds (editor, terminal, markdown, preview, git-history, git-diff)

#### `src/modules/settings/store.ts`

Remove:

- Imports from `@/modules/ai/config` (autocomplete types, compat model info, etc.)
- `autocompleteEnabled`, `autocompleteTrigger`, `autocompleteProvider`, `autocompleteModelId` preference keys and defaults
- `openaiCompatibleBaseURL`, `openaiCompatibleModelId`, `openaiCompatibleContextLimit` preference keys and defaults
- `lspActivation`, `lspCustomServers` preference keys and defaults
- `setLspActivation()` function
- Change `editorFormatter` default from `"lsp"` to `"prettier"` (first available external formatter)

#### `src/settings/sections/EditorSection.tsx`

Remove:

- `<LspServersGroup>` import and rendering
- `"lsp"` option from formatter dropdown

### 2.2. Lighter modifications

| File | Change |
| --- | --- |
| `src/modules/tabs/TabBar.tsx` | Remove `ai-diff` tab rendering branch |
| `src/modules/tabs/AgentTabBadge.tsx` | Delete (agent-specific tab badge) |
| `src/modules/editor/index.ts` | Remove `AiDiffStack` re-export |
| `src/modules/editor/lib/extensions.ts` | Remove `lspCompartment` export |
| `src/modules/editor/lib/externalFormat.ts` | Remove `"lsp"` from `EditorFormatter` type union; remove `"Language server"` label from formatter map; update fallback logic that falls back to `"lsp"` |
| `src/modules/editor/lib/useDocument.ts` | Remove `notifyDocumentSaved` import and call |
| `src/modules/header/Header.tsx` | Remove agents import (NotificationBell from `@/modules/agents`) |
| `src/modules/terminal/block/BlockOverlay.tsx` | Remove `useChatStore` import and usage |
| `src/modules/explorer/FileExplorer.tsx` | Remove `onAttachToAgent` prop and the "Attach to Agent" context menu action |
| `src/modules/markdown/MarkdownPreviewPane.tsx` | Replace `ai-elements/markdown-code` import with a local copy of the markdown code renderer |
| `src/modules/statusbar/StatusBar.tsx` | Remove `<LspStatusPill>` and `<DiagnosticsBadge>` (if pure LSP); remove `from "@/modules/lsp"` imports |
| `src/modules/statusbar/DiagnosticsBadge.tsx` | Delete if solely LSP-driven |
| `src/modules/shortcuts/shortcuts.ts` | Remove AI shortcuts: `ai.toggle`, `ai.toggleMini`, `ai.askSelection`, `agent.focusAttention`, `editor.aiComplete` |
| `src/settings/SettingsApp.tsx` | Remove ModelsSection and AgentsSection from nav; remove LspServersGroup if present |
| `vite.config.ts` | Remove AI SDK chunk-splitting rules (lines 93-103) |
| `package.json` | Remove `ai` and 7 `@ai-sdk/*` dependencies (`@ai-sdk/anthropic`, `@ai-sdk/cerebras`, `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/react`, `@ai-sdk/xai`) |

### 2.3. One-line import removals

These files import from `@/modules/ai` only for non-AI utilities that happen to live there (e.g., `native.ts` for git/filesystem commands). After relocating those utilities, the imports are simply dropped:

| File | AI Import Used |
| --- | --- |
| `src/modules/git-history/GitHistoryPane.tsx` | `native` (git operations) |
| `src/modules/git-history/lib/graph.ts` | `native` (git operations) |
| `src/modules/source-control/SourceControlPanel.tsx` | `native` (git operations) |
| `src/modules/source-control/useSourceControl.ts` | `native` (git operations) |
| `src/modules/source-control/useSourceControlContext.ts` | `native` (git operations) |
| `src/modules/source-control/useSourceControlPanel.ts` | `native` (git operations) |
| `src/modules/spaces/lib/useSpacesBoot.ts` | `native` (workspace ops) |
| `src/modules/statusbar/StatusBar.tsx` | `native` (status ops) |
| `src/app/components/WorkspaceInputBar.tsx` | `native` (workspace ops) |
| `src/app/components/useGitBranch.ts` | `native` (git ops) |
| `src/modules/explorer/FileExplorer.tsx` | `native` (fs ops) |
| `src/modules/explorer/lib/gitStatusUtils.ts` | `native` (git ops) |
| `src/modules/terminal/block/BlockOverlay.tsx` | `useChatStore` (agent activity) |

**Critical prerequisite:** `src/modules/ai/lib/native.ts` must be relocated to a shared location (e.g., `src/lib/native.ts` or `src/modules/native/index.ts`) before deletion. This file contains Tauri IPC wrappers for filesystem, git, shell, PTY, and workspace operations — none of which are AI-specific.

### 2.4. Rust backend modifications

#### `src-tauri/src/lib.rs`

Remove:

- `agent` from `use modules::{…}` (line 3)
- `lsp` from `use modules::{…}` (line 3)
- `agent::emit_conout_marker(agent, event)` call in OSC handler (lines 164-165)
- `lsp::LspState` management (line 227)
- 6 `lsp::*` Tauri command registrations (lines 262-267)
- LSP kill-on-exit hook (line 329)
- `agent::agent_enable_hooks` and `agent::agent_hooks_status` Tauri commands (lines 308-309)

#### `src-tauri/src/modules/mod.rs`

Remove:

- `pub mod agent;`
- `pub mod lsp;` (re-check — the per-file listing shows it's already just the one module declaration per file)

Actually from the tree: `src-tauri/src/modules/mod.rs` has `nodeCount: 1` — it likely just re-exports all submodules. Remove `agent` and `lsp` from whatever mechanism it uses.

#### `src-tauri/src/modules/pty/mod.rs`

Remove:

- `mod agent_detect;` (line 1)

#### `src-tauri/src/modules/pty/session.rs`

Remove:

- `use super::agent_detect::AgentDetector;` import (line 11)
- `AgentDetector::new()` and the `.process()` and `.finish()` calls in the PTY read loop (~25 lines)
- Any agent-related event handling

#### `src-tauri/src/modules/shell/mod.rs`

Check for agent-related shell init functions and remove if present.

---

## Section 3: What Stays (Preserved)

| Area | Status |
| --- | --- |
| **Terminal / PTY** | Intact — all PTY session management, shell init, OSC handlers (minus agent markers) |
| **File Explorer** | Intact — file tree, inline rename, drag-drop, search, git status icons |
| **Editor** | Intact — syntax highlighting (Lezer), theming, vim mode, indent, EOL, language detection, external formatters (prettier, biome, etc.) |
| **Source Control** | Intact — git staging, unstaging, diff, commit, branch |
| **Git History** | Intact — graph, commit list, blame, log |
| **Markdown Preview** | Intact — with extracted local markdown-code renderer |
| **Web Preview** | Intact — address bar, iframe rendering |
| **Themes** | Intact — all 16 built-in themes, custom themes, editor themes |
| **Spaces / Workspaces** | Intact — workspace creation, switching, serialization, env management |
| **Command Palette** | Intact — fuzzy search, MRU, mode switching |
| **Settings** | Intact — editor, general, themes, shortcuts sections; minus Models, Agents, LSP |
| **Status Bar** | Intact — CWD breadcrumb, workspace env selector |
| **Tabs** | Intact — editor, terminal, markdown, preview, git-history, git-diff tabs; minus ai-diff |
| **Keyboard Shortcuts** | Intact — minus 5 AI-specific bindings |
| **Rust Backend** | Intact — fs, git, history, net, proc, pty (minus agent detect), secrets, shell, workspace modules |
| **Updater** | Intact |
| **Shell init scripts** | Intact |

---

## Section 4: Verification Gates

1. **TypeScript compilation** — `pnpm tsc --noEmit` passes with zero errors
2. **Vite build** — `pnpm build` produces a working bundle with no AI/LSP chunks
3. **Rust compilation** — `cargo build` in `src-tauri/` passes with no warnings
4. **Terminal smoke test** — open terminal, run commands, verify PTY still functional
5. **Editor smoke test** — open a `.ts` file, verify syntax highlighting, save, external format
6. **Source control smoke test** — stage/unstage, commit, view diff
7. **File explorer smoke test** — navigate tree, create/rename/delete files
8. **Settings window** — opens without errors; Models, Agents, LSP sections absent
9. **Keyboard shortcuts** — AI/LSP shortcuts removed from config; remaining shortcuts functional
10. **No runtime errors** — open browser console, verify no missing module errors

---

## Section 5: Edge Cases & Risks

1. **`native.ts` relocation** — This file is in `src/modules/ai/lib/native.ts` but is NOT AI-specific. It must be moved to `src/lib/native.ts` before the AI directory is deleted. All 13 consumers must have their import paths updated.

2. **`markdown-code` extraction** — `src/modules/markdown/MarkdownPreviewPane.tsx` imports from `src/components/ai-elements/markdown-code.tsx`. The markdown code renderer is not AI-specific (it just renders code blocks in markdown). Extract it to `src/modules/markdown/lib/markdown-code.tsx` before deleting `ai-elements/`.

3. **Settings store constants** — `src/modules/settings/store.ts` imports `OPENAI_COMPATIBLE_DEFAULT_BASE_URL` from `@/modules/ai/config`. This constant is only used for the compat model defaults which are being removed. But check: is it also used for non-AI settings? If yes, inline the value.

4. **`externalFormat.ts` fallback** — Currently falls back to `"lsp"` when no external formatter matches. After removal, the fallback should be the editor's default formatter or "none".

5. **Editor `lspCompartment`** — Used in `EditorPane.tsx` to enable/disable LSP features. After removal, any reference to this compartment (imported from `extensions.ts`) must be cleaned up so the editor doesn't error.

6. **`useDocument.ts`** — Calls `notifyDocumentSaved` from LSP on document save. Remove the import and call; the rest of document management stays.

7. **`pnpm-lock.yaml`** — Will need regeneration after `package.json` changes (`pnpm install`).

8. **Shell integration** — Check `src-tauri/src/modules/pty/shell_init.rs` for any agent-specific shell init scripts or markers that should be removed.

---

## Section 6: Total Impact

| Metric | Count |
| --- | --- |
| Directories deleted | 7 |
| Files deleted | ~99 |
| Files modified | ~37 |
| npm dependencies removed | 8 (`ai` + 7 `@ai-sdk/*`) |
| Rust modules removed | 2 (`agent`, `lsp`) |
| Estimated code removed | ~25% of codebase |
