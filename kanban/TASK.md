# Planner task registration

The preferred model-facing `register_planner_task` contract is flat and minimal:

```yaml
title: One observable result
files:
  - exact/existing/path
  - exact/missing/path
  - READ: exact/read-only/context/path
done:
  - One concrete technically verifiable completion fact.
depends_on:
  - 078-prerequisite-task.md
```

`depends_on` is optional. Use exact `.md` filenames without `kanban/todo/`.

`files` is the complete file contract:

- Existing or changed paths become mutation Scope.
- Missing paths become `NEW:` mutation Scope; stale `NEW:` markers on existing files are removed.
- Technically valid project paths may contain spaces or shell metacharacters; derived commands quote them.
- `NEW:` remains accepted only as repairable legacy input; new Planner calls omit it.
- `READ:` paths must already be regular project files. They become read-only Context and never mutation Scope.
- Invalid paths and symbolic links fail closed with one exact next action.

`done` contains concrete technical completion facts, not test scores or model-quality judgments. The Harness derives the task path, Outcome, canonical Scope and Context, Requirements, Scheduling, Resources, Memory metadata, and exact executable Verify commands when project state makes them unambiguous. If no command is mechanically tied to the files, the canonical Verify section remains empty.

New tasks do not contain Behavior scenarios, contract-direction labels, risk classes, or other project-specific policy metadata. Legacy task files may still be parsed for lifecycle compatibility, but those fields are not synthesized, compared, or scored.

The stored task remains expanded canonical Markdown for Task Doctor, Worker, Executor, recovery receipts, and historical compatibility. Legacy expanded Planner input remains readable, but new Planner calls should use only `title`, `files`, `done`, and optional `depends_on`.
