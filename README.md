# OpenCode Web Harness

OpenCode Web Harness is a reusable web-application template. The repository combines a runnable full-stack starter with a controlled, Kanban-based OpenCode workflow.

The workflow is model-independent. Providers and models are not hard-coded. Planner, Executor, and Worker may use the same or different OpenCode models as long as those models can call the required tools reliably.

## Quick Start

Create a project from the repository and install its locked dependencies:

```bash
git clone https://github.com/ghtkuhn/opencode-web-harness.git my-app
cd my-app
npm run setup
```

Set the application `name`, ports, and optional agent models in `project.json`, then start the app:

```bash
npm run app:start
```

Open the project in OpenCode, give the requirement to Planner, and continue with Executor after Planner has registered the tasks. See [Setup](#setup), [Configuration](#configuration), and [Recommended Usage](#recommended-usage) for the available options.

## What It Does

- Backend with Express, Kysely, SQLite, and TypeScript
- Frontend with React, Bootstrap, Vite, and TypeScript
- Playwright for browser E2E tests
- Central runtime and workflow configuration in `project.json`
- Planner, Executor, and Worker as separate OpenCode roles
- Task Doctor for task validation, scope control, and verification
- Workflow Guards for roles, permissions, technical recovery, and repetition protection
- Git-free Harness updates from versioned GitHub releases
- Project-wide Memory, Custom, and Worker rules

## Setup

Node.js, npm, and an OpenCode installation are required. Dependencies are not stored in Git, so run the setup command once after cloning or whenever the local dependencies are absent:

```bash
npm run setup
```

This installs the locked Root, Backend, Frontend, and OpenCode dependencies. Existing installations do not need to run it again.

Next, configure `project.json` and start the application:

```bash
npm run app:start
npm run app:status
```

By default, the frontend runs at `http://localhost:5173` and the backend runs on port `3001`. Both ports are configured in `project.json`.

## Recommended Usage

1. Set the project name, ports, and optional agent models in `project.json`.
2. Start a Planner session for a new or unclear requirement.
3. Resolve any material product decision that cannot be derived from the request or project.
4. After registration, start an Executor session to process the tasks.
5. Let Executor delegate Workers and perform the technical completion transition.
6. Maintain durable project rules through `CUSTOM.md`, Worker learnings through `WORKER.md`, and project knowledge through `MEMORY.md`.

Tasks should remain small and state an unambiguous result. The Harness makes operations safe and reproducible; task design remains responsible for product intent.

## Roles and Workflow

### 1. Planner

Planner analyzes the request and existing project evidence. It asks only about a material decision that cannot be derived, then registers tasks through the minimal `title`, `files`, `done`, and optional `depends_on` tool contract. It may read application code but must not modify it. Registration derives the canonical task file and Doctor metadata atomically, then Planner stops.

### 2. Executor

Executor asks Doctor for runnable tasks and delegates only `READY` tasks. It respects the configured Worker limit and advances only the exact technical recovery path returned by the Harness. After Doctor PASS, Executor invokes the zero-argument, hash-bound completion transition. It does not grade implementation quality or author review findings.

### 3. Worker

A Worker handles exactly one delegated task. It reads its rules and task, remains inside declared scope, and changes files only through a flat Preview followed by zero-argument Apply or Discard. The Harness validates the operation and runs any exact task verification commands mechanically. After `TASK DOCTOR: PASS`, Worker returns `REVIEWABLE` to Executor and stops.

### 4. Technical Completion

The completion transition checks only the active task hash, verified filesystem snapshot, path safety, and Doctor state before moving the task to `kanban/done`. It has no verdict, findings, score, locator semantics, translation semantics, architecture policy, or test-quality judgment. After repeated technical blockers, Worker may return `HELP_REQUESTED`; the persisted receipt selects a retry or Planner-owned task correction.

## Configuration

The application name is the top-level `name` field in `project.json`; all other project-specific settings are located under `settings`.

| Setting | Description |
| --- | --- |
| Top-level `name` | Name of the application created from the template |
| `maxMemorySize` | Maximum size of `MEMORY.md`, for example `15kb` |
| `harnessUpdate.repository` | GitHub repository used for Harness releases |
| `taskDoctor.verifyState` | Checks whether tests restore configured persistent state |
| `verifyState` | List of persistent SQLite files that Doctor should compare |
| `appRuntime.backendPort` | Backend port |
| `appRuntime.frontendPort` | Frontend port |
| `opencode.agentModels` | Optional model assignment for each agent role |
| `opencode.workerRecoveryBoost` | Optional stronger model for one reviewed Worker recovery attempt |
| `opencode.workerPool.maxConcurrentWorkers` | Maximum number of parallel Workers, from 1 to 16 |
| `opencode.workerHelp.failureThreshold` | Number of distinct failed attempts before returning a help request |
| `opencode.taskCompactionThresholdPercent` | Context threshold for compaction after a task |
| `opencode.workflowGuard` | Individually configurable workflow protection features |
| `opencode.modes` | Role names and their permitted paths |
| `opencode.protectedAgentPaths` | Workflow internals protected from agents |
| `opencode.readOnlyAgentPaths` | Rule files that agents may only read |
| `opencode.modelDrivers` | Optional special drivers activated only for matching model identities |

### Assigning Models

Provider, endpoint, API key, and available models are configured in OpenCode. The template can optionally assign known OpenCode model names to specific roles:

```json
{
  "settings": {
    "opencode": {
      "agentModels": {
        "planner": "provider/model",
        "executor": "provider/model",
        "worker": "provider/model"
      }
    }
  }
}
```

An empty assignment (`"agentModels": {}`) uses the OpenCode default models. Roles may use the same or different models. Restart OpenCode after changing the assignment so that all new sessions load the updated configuration.

Practical model-selection tips:

| Role | Prefer | Why |
| --- | --- | --- |
| Planner | Strong reasoning and a large context window | It must turn ambiguous requests and project evidence into technically precise tasks. |
| Executor | Reliable instruction following and tool calls | It mainly follows persisted state, delegates exact tasks, and advances technical recovery paths. |
| Worker | Fast, economical, reliable tool use | Its work is narrowly scoped; a smaller model is often sufficient when it handles the required tools consistently. |

Using one reliable model for all three roles is a good starting point. Compare models by successful technical operations, correct tool calls, and task completion rate; the Harness does not score implementation quality.

For reviewed Worker retries, an optional recovery boost can temporarily use the configured Planner or Executor model. It applies only to the reviewed hurdle and then returns to the normal Worker model:

```json
{
  "settings": {
    "opencode": {
      "workerRecoveryBoost": {
        "enabled": true,
        "model": "executor"
      }
    }
  }
}
```

The referenced role must have a valid entry in `agentModels`. A direct `"provider/model"` value is also accepted.

### Updating the Harness

A project created from this template can update its workflow Harness without being a Git repository and without having Git installed. The updater uses Node.js HTTPS requests to resolve the latest release from [GitHub Releases](https://github.com/ghtkuhn/opencode-web-harness/releases).

Run a read-only comparison first when needed:

```bash
npm run harness:update:check
```

Apply the latest release with:

```bash
npm run harness:update
```

`harness-manifest.json` limits updates to Harness-owned files such as `AGENTS.md`, `kanban/TASK.md`, Task Doctor, application control, OpenCode roles, plugins, libraries, and their tests. Application code, `project.json`, `README.md`, `MEMORY.md`, `CUSTOM.md`, `WORKER.md`, and Kanban task history are not replaced. Reserved Harness scripts and protected paths are merged into `package.json` and `project.json` without removing project-specific entries.

The updater runs only through the explicit CLI command; ordinary requests containing the word “template” are not intercepted. It downloads and validates the complete release before changing files. Changed files are backed up under `.runtime/harness-update-backups`, writes are atomic, and changed Harness-local dependencies are installed automatically. A failed write or dependency installation restores the managed files and previous dependency set. The applied release is recorded in `.runtime/harness-update.json`. Restart OpenCode after a successful update so that new agent sessions load the updated plugins and role definitions.

Public releases do not require credentials. `GITHUB_TOKEN` may be set when a higher GitHub API rate limit is needed.

### Protecting Persistent Test State

Doctor can check whether tests modify a SQLite database without cleaning it up afterward:

```json
{
  "settings": {
    "taskDoctor": {
      "verifyState": true
    },
    "verifyState": [
      {
        "type": "sqlite",
        "path": "code/database/app.db"
      }
    ]
  }
}
```

The list may remain empty if the project has no persistent test state.

## Writing Tasks

The preferred Planner call contains only:

- `title`: one short result
- `files`: exact mutation paths plus optional `READ:` context paths
- `done`: concrete technical completion facts
- `depends_on`: optional exact task filenames

The Harness derives file existence, canonical Scope and Context, scheduling metadata, Memory metadata, and exact verification commands when project metadata makes them unambiguous. Empty verification is valid. New tasks do not synthesize Behavior IDs, contract-direction labels, HTTP risk, test-style requirements, or backend/frontend ordering. Legacy task files remain readable for lifecycle compatibility without making those fields active policy.

## Important Commands

### Application

```bash
npm run app:status
npm run app:start
npm run app:stop
npm run app:restart
npm run app:clear-ports
```

### Task Doctor

```bash
npm run task:doctor:test
npm run task:doctor:lint -- kanban/todo/01-example.md
npm run task:doctor:register -- kanban/todo/01-example.md
npm run task:doctor:schedule
npm run task:doctor:start -- kanban/todo/01-example.md
npm run task:doctor:verify -- kanban/todo/01-example.md
```

Planner, Executor, and Worker run only the commands allowed for their respective roles. Doctor output is authoritative and must not be bypassed with manual substitute checks.

### Browser E2E Tests

```bash
npm run test:e2e
```

## Local Runtime Data

`.task-doctor`, `.runtime`, Playwright reports, and Kanban files in `kanban/todo`, `kanban/done`, and `kanban/superseded` are local runtime data and are not versioned. The `.gitkeep` files preserve the empty Kanban directories in the repository. To commit task history intentionally, adjust the corresponding rules in `.gitignore`.

## Project Structure

| Path | Purpose |
| --- | --- |
| `code/backend` | Backend application and backend tests |
| `code/frontend` | Frontend application and browser E2E tests |
| `code/database` | Local persistent data |
| `kanban/TASK.md` | Minimal model-facing task contract |
| `kanban/todo` | Tasks that can be registered or are active |
| `kanban/done` | Tasks completed by the workflow |
| `scripts/task-doctor.mjs` | Task lifecycle and verification |
| `scripts/app-control.mjs` | Application start, stop, and port management |
| `scripts/update-harness.mjs` | Git-free release updater for managed Harness files |
| `harness-manifest.json` | Authoritative list of files and package scripts owned by the Harness |
| `.opencode/agents` | Definitions of the three agent roles |
| `.opencode/plugins` | Project-local Workflow Guards |
| `project.json` | Central project configuration |
| `AGENTS.md` | Authoritative working rules |
| `MEMORY.md` | Durable project knowledge |
| `CUSTOM.md` | Rules are project- or user-maintained and read by Planner |
| `WORKER.md` | Learned Guard rules for Worker |
