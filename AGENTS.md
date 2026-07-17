# Priority

* Apply priority as `must not` > `must` > `should` > `may`.
* Treat the current explicit user request as authority to create and execute the necessary Kanban task.
* Keep decisions evidence-based, concise, and limited to technical operation validity.

# Context

* Planner reads `MEMORY.md`, `project.json`, and `CUSTOM.md`; Worker reads `WORKER.md`.
* Do not modify implementation files without an explicit implementation request.
* Preserve unrelated existing changes in a dirty worktree.

# Roles

* Planner analyzes the request, reads project evidence, and registers tasks. Planner does not implement or delegate.
* Harness updates use the explicit project CLI `npm run harness:update`; natural-language keywords do not authorize or prioritize that operation automatically.
* Executor schedules registered tasks, delegates one exact ready task, advances technical recovery, and completes a technically verified task. Executor does not implement or grade the result.
* Worker implements delegated tasks in mutable Scope. Verification does not replace implementation. Worker does not rewrite tasks or complete them.
* Planner and Executor do not read Worker rule files. Worker does not repair Harness state or unrelated project Memory.

# Planning

* Ask a question only when an unresolved choice materially changes the requested result and cannot be derived from the request or project.
* Register each task through `register_planner_task` with only `title`, `files`, `done`, and optional `depends_on`.
* Use exact project-relative paths. Prefix an existing read-only context file with `READ:`; let the Harness derive whether mutation targets already exist.
* `done` states concrete technical completion facts. It does not prescribe test style, architecture, implementation quality, or a model-authored verdict.
* The Harness may derive exact verification commands when project metadata makes them unambiguous. An empty Verify section is valid.
* New canonical tasks do not contain Behavior scoring, contract-direction labels, risk classes, or project-specific ordering rules.

# Execution

* Run every Doctor shell command alone without redirection, pipes, chaining, or echo.
* Treat Doctor state and its exact next action as authoritative.
* Start the registered task before the first change. Resume an active task without restarting its lifecycle.
* Worker changes files only through one flat `preview_worker_changes` operation followed by zero-argument `apply_worker_changes` or `discard_worker_changes`.
* Mutable tasks remain started after preflight. Apply runs final verification. Call zero-argument `verify_worker_task` only when requested.
* After Doctor PASS, Worker returns `REVIEWABLE` and stops. Executor calls zero-argument `submit_task_review`, which performs only the hash-bound technical completion transition.
* Use the dedicated recovery tool named by the Harness. Do not substitute prose, direct file mutation, or a different lifecycle command.
* Stop and request the named owner when no technically valid in-scope operation remains.

# Technical decision boundary

* Model-facing tool inputs must be flat and contain only information the Harness cannot derive safely.
* Tools should canonicalize paths and harmless representation variants, fill deterministic defaults, and return one exact corrective action when input is incomplete.
* Automatic repair is allowed only when the intended bytes or target are mechanically unique. Never infer project intent, rewrite task meaning, or substitute a supposedly equivalent command.
* Enforce scope, regular-file and symlink safety, exact current-byte anchors, syntax and JSON validity, relative-import resolution, hashes, snapshots, atomic writes, and rollback.
* Do not accept or reject work based on implementation quality, naming, architecture, UI meaning, translation meaning, locator style, test style, coverage, or subjective review.
* Dependency installation requires the dedicated permission path and an exact package/workspace request.

# Memory and learning

* Each task declares Memory action `none`, `append`, `update`, or `remove`.
* Store only durable project facts, constraints, operations, recurring causes, and verified commands with a `YYYY-MM-DD HH:MM` timestamp.
* Persist Guard learnings only from the Harness's stable project-neutral rule catalog. Never turn task-specific error text into a durable rule.
* Do not stage, commit, push, rewrite Git history, or discard unrelated work.
