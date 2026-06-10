# Claude Instructions — ScopeKit

This project uses **ScopeKit**. Module ownership, dependencies, and constraints are
defined in `AGENTS/scopekit.json` and the `AGENTS/MOD-XXX.md` briefs.

## Before editing any file

Call `scopekit_get_context` with the file path (or its module ID) and read the brief.
It tells you which files you may edit and which invariants you must respect.

A **PreToolUse hook** enforces this: the first time you edit a file in a module, the
edit is blocked once and the module's scoped context is injected. Read it, then re-issue
the edit. You will not be interrupted again for that module this session.

## Rules

- Edit only files listed under the **Files in scope** of the module you loaded.
- A dependency's **Contract** and **Invariants** are read-only context — do not edit
  files in dependency modules; call `scopekit_get_context` for that module if you must.
- Module dependencies are derived from real imports — if you add a cross-module import,
  the graph updates itself.
- After changing code that a brief describes, update the brief and run `scopekit verify`.

## Tools

| Tool | When |
|------|------|
| `scopekit_get_context` | Before editing — load a module's scope + dependency contracts |
| `scopekit_resolve_module` | Find which module owns a file |
| `scopekit_list_modules` | Browse the registry |
| `scopekit_verify` | Confirm briefs still match the code (anchors, globs, deps) |
| `scopekit_scaffold` | First-time setup: propose modules from the import graph |

## Module Map

| ID | Name | Primary Files |
|----|------|---------------|
| MOD-001 | DB Connection & Query Engine | `src/store/DbContext.tsx`, `src/services/api.ts`, `src-tauri/src/lib.rs` |
| MOD-002 | Annotation System | `src/components/annotations/`, `src/store/AnnotationContext.tsx` |
| MOD-003 | AI / NLQ SQL Generation | `src/components/NLQInterface.tsx`, `src/services/llm.ts` |
| MOD-004 | App Data Store & Credentials | `src-tauri/src/appdb.rs`, `src/services/sync.ts` |
| MOD-005 | Cloudflare R2 Backup | `src-tauri/src/sync.rs`, `src/components/SyncSettings.tsx` |
| MOD-006 | UI Primitives & Theme | `src/components/ui/`, `src/index.css` |
| MOD-007 | App Shell & Routing | `src/App.tsx`, `src/components/DataExplorer.tsx` |
| MOD-008 | Onboarding Guide | `src/components/SetupGuide.tsx` |

## Project-Wide Rules

1. All Tauri commands must be `async`, return `Result<T, String>`, and be registered in `invoke_handler![]` in `src-tauri/src/lib.rs`.
2. New shared TypeScript types go in `src/types/api.ts`, not inline.
3. CSS: use variables from `src/index.css` (`--primary`, `--border`, etc.). No raw hex colors.
4. Secrets (passwords, API keys) go in the OS keychain via `credential_set` — never in SQLite.
5. `validate_table_name()` must be called before any table/column name is used in raw SQL.
