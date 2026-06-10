# IntelQuery — Agent Module Registry

## How This System Works

Every logical module of the codebase has a numbered context file in this directory.
When an edit is requested, a scoped agent is spawned with:

1. **This INDEX.md** — to understand the module map
2. **The target module's CONTEXT.md** — as the primary briefing
3. **CONTEXT.md files of declared dependencies** — for cross-module understanding (read-only)
4. **Source files in scope only** — the agent reads and edits only files listed under `scope`

This keeps token consumption minimal: the agent never blindly loads the whole codebase.

---

## How to Trigger a Scoped Edit

Say one of the following:

- `"MOD-003: change the system prompt to include annotations"`
- `"In MOD-001, add connection timeout support"`
- `"Edit the NLQ module (3) to..."`

I will spawn an agent pre-loaded with the right context and scoped to the right files.

---

## Module Registry

| ID      | Name                          | Context File       | Primary Dir                              |
|---------|-------------------------------|--------------------|------------------------------------------|
| MOD-001 | DB Connection & Query Engine  | `MOD-001.md`       | `src/store/`, `src-tauri/src/lib.rs`     |
| MOD-002 | Annotation System             | `MOD-002.md`       | `src/components/annotations/`            |
| MOD-003 | AI / NLQ SQL Generation       | `MOD-003.md`       | `src/components/NLQInterface.tsx`        |
| MOD-004 | App Data Store & Credentials  | `MOD-004.md`       | `src-tauri/src/appdb.rs`                 |
| MOD-005 | Cloudflare R2 Backup          | `MOD-005.md`       | `src-tauri/src/sync.rs`                  |
| MOD-006 | UI Primitives & Theme         | `MOD-006.md`       | `src/components/ui/`, `src/index.css`    |
| MOD-007 | App Shell & Routing           | `MOD-007.md`       | `src/App.tsx`                            |

---

## Dependency Graph

```
MOD-007 (App Shell)
  ├── MOD-001 (DB Connection)
  │     └── MOD-004 (App Data Store)
  ├── MOD-002 (Annotations)
  │     └── MOD-001
  ├── MOD-003 (NLQ)
  │     ├── MOD-001
  │     └── MOD-002 (future injection)
  ├── MOD-005 (R2 Backup)
  │     └── MOD-004
  └── MOD-006 (UI & Theme)
```

Foundational (no deps): **MOD-004**, **MOD-006**

---

## Shared Contracts (read by all agents)

Every agent must be aware of these cross-cutting files even if not editing them:

| File                    | Why It Matters                                                     |
|-------------------------|--------------------------------------------------------------------|
| `src/types/api.ts`      | Shared TypeScript interfaces — changes here affect every module    |
| `src/utils/tauri.ts`    | `safeInvoke<T>()` — all Tauri IPC goes through this               |
| `src-tauri/src/lib.rs`  | All Tauri command registration — new commands must be added here   |
| `src/index.css`         | Design tokens (CSS vars) — button/form styles used everywhere      |

---

## Rules for Agents

1. **Read only files in your scope** unless a cross-module check is explicitly needed.
2. **For cross-module needs**: read the other module's `CONTEXT.md` first. Only read source if the CONTEXT.md is insufficient.
3. **New Tauri commands** must be registered in `lib.rs` `invoke_handler![]`. Always check if the command already exists.
4. **New types** shared across modules go in `src/types/api.ts`, not inline.
5. **CSS**: use existing variables from `src/index.css` (`--primary`, `--border`, etc.). Do not add inline hex colors.
6. **Never store secrets** in `app-data.db`. Passwords and API keys go in the OS keychain via `credential_set`.
7. **Rust**: run `cargo check` mentally — all new Tauri commands must be `async` and return `Result<T, String>`.
