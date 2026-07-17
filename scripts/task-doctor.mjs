#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(root, '.task-doctor');
const statePath = resolve(dataDirectory, 'state.json');
const reportsDirectory = resolve(dataDirectory, 'reports');
const lintsDirectory = resolve(dataDirectory, 'lints');
const registrationsDirectory = resolve(dataDirectory, 'registrations');
const ignorePath = resolve(root, '.taskdoctorignore');
const memoryPath = resolve(root, 'MEMORY.md');
const projectConfigPath = resolve(root, 'project.json');
const authorizedCustomChangesPath = resolve(dataDirectory, 'authorized-custom-changes.json');
const authorizedMemoryChangesPath = resolve(dataDirectory, 'authorized-memory-changes.json');
const authorizedHarnessChangesPath = resolve(dataDirectory, 'authorized-harness-changes.json');
const operationalDirectoryNames = new Set(['.git', '.task-doctor', '.runtime', 'node_modules']);
const generatedNames = new Set(['dist', 'build', 'coverage', '.vite', 'test-results']);
const ignoredDirectories = new Set([...operationalDirectoryNames, ...generatedNames]);
const packageLockNames = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const forbiddenCommand = /(?:\|\s*(?:head|tail|grep|rg|sed|awk)\b|\|\|\s*true\b|\bgit\s+(?:add|commit|push|reset|checkout|restore|rebase|merge)\b|(?:^|\s)(?:rm\s+-rf|sudo)\b)/;
const executableTestPattern = /(?:\btest(?::[\w-]+)?\b|\bvitest\b|\bjest\b|\bplaywright\b|\btsx\s+--test\b|\bnode\s+--test\b)/;
const taskDoctorDefaults = {
    verifyState: true,
};
const gitMode = runGitProbe();
const filesystemIgnorePatterns = readIgnorePatterns();
const projectConfig = readProjectConfig();
const taskDoctorSettings = readTaskDoctorSettings();
const maxMemorySize = readMaxMemorySize();
const verifyStateConfig = readVerifyStateConfig();
const workerPoolSettings = readWorkerPoolSettings();
const executorBaselineRecoveryEnabled = readExecutorBaselineRecoveryEnabled();
const executorRecoveryPatterns = readExecutorRecoveryPatterns();

function parseVerifyCommands(verifyBlock) {
    return verifyBlock.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^-\s+(.+?)\s*$/);
        if (!match) return [];
        let command = match[1].trim();
        let expectedExit = 0;
        const expected = command.match(/\s+\(expect exit (\d+)\)$/);
        if (expected) {
            expectedExit = Number(expected[1]);
            command = command.slice(0, expected.index).trim();
        }
        if (command.startsWith('`') && command.endsWith('`') && command.length >= 2) {
            command = command.slice(1, -1);
        }
        return [{ command, expectedExit }];
    });
}

function verifyCommandFormatError(command) {
    const syntax = run('/bin/sh', ['-n', '-c', command]);
    if (syntax.status !== 0) {
        const detail = syntax.stderr.trim().split(/\r?\n/).at(-1) ?? `exit ${syntax.status ?? 'signal'}`;
        return `VERIFY_COMMAND_SYNTAX: invalid shell command: ${command}; ${detail}`;
    }
    return null;
}

function verifyNpmScriptErrors(command) {
    const errors = [];
    const invocation = /(?:^|&&|\|\||;)\s*npm\s+(?:--prefix(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s+)?run\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
    for (const match of command.matchAll(invocation)) {
        const prefix = match[1] ?? match[2] ?? match[3] ?? '.';
        const script = match[4] ?? match[5] ?? match[6];
        const manifestPath = resolve(root, prefix, 'package.json');
        const relativeManifest = normalizePath(relative(root, manifestPath));
        if (relativeManifest.startsWith('../') || relativeManifest === '..') {
            errors.push(`VERIFY_PACKAGE_OUTSIDE_PROJECT: npm prefix must remain in the project: ${prefix}`);
            continue;
        }
        if (!existsSync(manifestPath)) {
            errors.push(`VERIFY_PACKAGE_MISSING: ${relativeManifest} does not exist for npm script ${script}`);
            continue;
        }
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
            errors.push(`VERIFY_PACKAGE_INVALID: ${relativeManifest} is not valid JSON`);
            continue;
        }
        if (typeof manifest.scripts?.[script] !== 'string') {
            errors.push(`VERIFY_SCRIPT_MISSING: ${relativeManifest} has no script ${script}: ${command}`);
            continue;
        }
    }
    return errors;
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function fail(messages) {
    console.error('TASK DOCTOR: FAIL');
    for (const message of messages) console.error(`- ${message}`);
    process.exit(1);
}

function run(program, args, options = {}) {
    return spawnSync(program, args, { cwd: root, encoding: 'utf8', ...options });
}

function usableGitBaseline(insideWorkTreeStatus, headStatus) {
    return insideWorkTreeStatus === 0 && headStatus === 0;
}

function runGitProbe() {
    return usableGitBaseline(
        run('git', ['rev-parse', '--is-inside-work-tree']).status,
        run('git', ['rev-parse', '--verify', 'HEAD']).status,
    );
}

function readIgnorePatterns() {
    if (!existsSync(ignorePath)) return [];
    return readFileSync(ignorePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => normalizePath(line));
}

function parseByteSize(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i);
    if (!match) return null;
    const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024 }[(match[2] ?? 'b').toLowerCase()];
    const bytes = Number(match[1]) * multiplier;
    return Number.isSafeInteger(bytes) ? bytes : null;
}

function readProjectConfig() {
    if (!existsSync(projectConfigPath)) return {};
    try {
        return JSON.parse(readFileSync(projectConfigPath, 'utf8'));
    } catch (error) {
        fail([`PROJECT_CONFIG_INVALID: ${error instanceof Error ? error.message : 'project.json'}`]);
    }
}

function readTaskDoctorSettings() {
    const configured = projectConfig?.settings?.taskDoctor ?? {};
    return Object.fromEntries(
        Object.entries(taskDoctorDefaults).map(([key, fallback]) => [key, typeof configured[key] === 'boolean' ? configured[key] : fallback]),
    );
}

function readMaxMemorySize() {
    const configuredValue = projectConfig?.settings?.maxMemorySize;
    if (configuredValue === undefined) return null;
    const parsed = parseByteSize(configuredValue);
    if (parsed === null) fail([`PROJECT_CONFIG_INVALID: settings.maxMemorySize must use b, kb, or mb; received ${JSON.stringify(configuredValue)}`]);
    return parsed;
}

function readWorkerPoolSettings() {
    const configured = projectConfig?.settings?.opencode?.workerPool?.maxConcurrentWorkers ?? 1;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > 16) {
        fail(['PROJECT_CONFIG_INVALID: settings.opencode.workerPool.maxConcurrentWorkers must be an integer from 1 to 16']);
    }
    return { maxConcurrentWorkers: configured };
}

function readExecutorBaselineRecoveryEnabled() {
    const configured = projectConfig?.settings?.opencode?.workflowGuard?.executorBaselineRecovery;
    return typeof configured === 'boolean' ? configured : true;
}

function readExecutorRecoveryPatterns() {
    const settings = projectConfig?.settings?.opencode ?? {};
    const configured = settings.executorRecoveryPaths;
    if (configured !== undefined && (!Array.isArray(configured) || configured.some((value) => typeof value !== 'string' || !value.trim()))) {
        fail(['PROJECT_CONFIG_INVALID: settings.opencode.executorRecoveryPaths must be an array of non-empty project-relative patterns']);
    }
    const derived = [
        'AGENTS.md',
        'project.json',
        'opencode.json',
        'WORKER-*.md',
        ...(Array.isArray(settings.protectedAgentPaths) ? settings.protectedAgentPaths : []),
        ...(Array.isArray(settings.readOnlyAgentPaths) ? settings.readOnlyAgentPaths : []),
    ];
    return [...new Set((configured ?? derived).map((value) => normalizePath(value.trim())))];
}

function recoveryPatternMatches(path, pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (pattern.includes('*')) return new RegExp(`^${escaped}$`).test(path);
    return path === pattern || path.startsWith(`${pattern}/`);
}

function matchesExecutorRecoveryPath(path) {
    return executorRecoveryPatterns.some((pattern) => recoveryPatternMatches(path, pattern));
}

function readVerifyStateConfig() {
    const configured = projectConfig?.settings?.verifyState ?? [];
    if (!Array.isArray(configured)) fail(['PROJECT_CONFIG_INVALID: settings.verifyState must be an array']);
    return configured.map((entry, index) => {
        if (entry?.type !== 'sqlite' || typeof entry.path !== 'string' || !entry.path.trim()) {
            fail([`PROJECT_CONFIG_INVALID: settings.verifyState[${index}] needs type sqlite and a path`]);
        }
        const path = normalizePath(entry.path);
        const absolutePath = resolve(root, path);
        if (normalizePath(relative(root, absolutePath)).startsWith('../')) {
            fail([`PROJECT_CONFIG_INVALID: verifyState path leaves project root: ${path}`]);
        }
        return { type: 'sqlite', path };
    });
}

function memoryLimitStatus() {
    if (maxMemorySize === null || !existsSync(memoryPath)) return null;
    const size = readFileSync(memoryPath).length;
    return size > maxMemorySize
        ? { code: 'MEMORY_SIZE_EXCEEDED', size, maxSize: maxMemorySize }
        : null;
}

function memoryRecoveryMessage(status) {
    return `${status.code}: MEMORY.md is ${status.size} bytes; project.json allows ${status.maxSize} bytes`;
}

function failExecutorMemoryRecovery(status) {
    console.error('TASK DOCTOR: EXECUTOR RECOVERY REQUIRED');
    console.error(`- ${memoryRecoveryMessage(status)}`);
    console.error('- RECOVERY_OWNER: Executor must read MEMORY.md, preserve durable facts, and call recover_project_memory before delegation or completion.');
    process.exit(1);
}

function matchesFilesystemIgnore(path) {
    const normalized = normalizePath(path);
    if (normalized.split('/').some((segment) => operationalDirectoryNames.has(segment))) return true;
    return filesystemIgnorePatterns.some((pattern) => {
        if (pattern.endsWith('/**')) {
            const prefix = pattern.slice(0, -3);
            return normalized === prefix || normalized.startsWith(`${prefix}/`);
        }
        if (pattern.startsWith('*.')) return normalized.split('/').pop().endsWith(pattern.slice(1));
        if (pattern.endsWith('*')) return normalized.split('/').pop().startsWith(pattern.slice(0, -1));
        return normalized === pattern || normalized.startsWith(`${pattern}/`) || normalized.split('/').includes(pattern);
    });
}

function isIgnored(path) {
    if (matchesFilesystemIgnore(path)) return true;
    return gitMode && run('git', ['check-ignore', '-q', path]).status === 0;
}

function git(...args) {
    if (!gitMode) fail(['GIT_UNAVAILABLE: this check requires Git mode']);
    const result = run('git', args);
    if (result.status !== 0) fail([`GIT_ERROR: ${result.stderr.trim() || args.join(' ')}`]);
    return result.stdout;
}

function normalizePath(path) {
    return path.split(sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

function withPackageCompanions(paths) {
    const expanded = [...paths];
    for (const manifest of paths.filter((path) => path === 'package.json' || path.endsWith('/package.json'))) {
        const directory = normalizePath(dirname(manifest));
        for (const name of packageLockNames) {
            const companion = directory === '.' ? name : `${directory}/${name}`;
            if (existsSync(resolve(root, companion)) && !expanded.includes(companion)) expanded.push(companion);
        }
    }
    return expanded;
}

function sqliteLogicalState(path) {
    const absolutePath = resolve(root, path);
    if (!existsSync(absolutePath)) return { type: 'sqlite', path, exists: false, hash: null };
    const result = run('sqlite3', ['-readonly', absolutePath, '.dump'], { maxBuffer: 50 * 1024 * 1024 });
    if (result.status !== 0) fail([`VERIFY_STATE_ERROR: sqlite ${path}: ${result.stderr.trim() || `exit ${result.status ?? 'signal'}`}`]);
    return { type: 'sqlite', path, exists: true, hash: hash(result.stdout) };
}

function collectVerifyState() {
    if (!taskDoctorSettings.verifyState) return [];
    return verifyStateConfig.map((entry) => sqliteLogicalState(entry.path));
}

function changedVerifyState(before, after) {
    return after.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(before[index]));
}

function fileHash(path) {
    return hash(readFileSync(path));
}

function parseScopeEntries(scopeBlock) {
    const entries = [];
    let started = false;
    for (const line of scopeBlock.split(/\r?\n/)) {
        if (!started && line.trim() === '') continue;
        const match = line.match(/^-\s+(?:(NEW):\s*)?`?([^`]+?)`?\s*$/);
        if (!match) break;
        started = true;
        entries.push({ isNew: match[1] === 'NEW', path: normalizePath(match[2]) });
    }
    return entries;
}

function parseContextEntries(contextBlock) {
    const paths = [];
    const invalidLines = [];
    for (const line of contextBlock.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const match = line.match(/^-\s+`?([^`]+?)`?\s*$/);
        if (!match) {
            invalidLines.push(line.trim());
            continue;
        }
        paths.push(normalizePath(match[1]));
    }
    return { paths: [...new Set(paths)], invalidLines };
}

function contextPathError(path) {
    const formatError = scopePathFormatError(path);
    if (formatError) return formatError;
    return regularProjectFileError(path);
}

function regularProjectFileError(path) {
    const absolutePath = resolve(root, path);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
        return 'path must remain inside the project';
    }
    let current = root;
    let stats;
    for (const segment of relativePath.split('/')) {
        current = resolve(current, segment);
        try {
            stats = lstatSync(current);
        } catch {
            return 'path does not exist';
        }
        if (stats.isSymbolicLink()) return 'path must not contain a symbolic link';
    }
    return stats?.isFile() ? null : 'path must be a regular file';
}

function scopePathFormatError(path) {
    if (!path) return 'path is empty';
    if (path.startsWith('/') || path.startsWith('~')) return 'path must be project-relative';
    if (path.includes('\\')) return 'path must use forward slashes';
    if (path.split('/').some((segment) => segment === '.' || segment === '..')) return 'path must not contain dot segments';
    if (/[*?[\]]/.test(path)) return 'path must be exact and must not contain glob metacharacters';
    return null;
}

function taskDependencyExists(path, availableTaskPaths) {
    return availableTaskPaths instanceof Set
        ? availableTaskPaths.has(path)
        : existsSync(resolve(root, path));
}

function resolveTaskDependency(value, availableTaskPaths) {
    const cleaned = value.trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
    if (/^[^/]+\.md$/.test(cleaned)) return { name: cleaned, repaired: false };
    const exactPath = cleaned.match(/^kanban\/(?:todo|done)\/([^/]+\.md)$/);
    if (exactPath) return { name: exactPath[1], repaired: false };

    const pathWithoutSuffix = cleaned.match(/^kanban\/(todo|done)\/([^/]+)$/);
    if (pathWithoutSuffix) {
        const candidate = `kanban/${pathWithoutSuffix[1]}/${pathWithoutSuffix[2]}.md`;
        return taskDependencyExists(candidate, availableTaskPaths)
            ? { name: `${pathWithoutSuffix[2]}.md`, repaired: true }
            : null;
    }
    if (!/^[^/]+$/.test(cleaned)) return null;
    const name = `${cleaned}.md`;
    const candidates = [`kanban/todo/${name}`, `kanban/done/${name}`]
        .filter((candidate) => taskDependencyExists(candidate, availableTaskPaths));
    return candidates.length === 1 ? { name, repaired: true } : null;
}

function normalizeTaskDependency(value, availableTaskPaths) {
    return resolveTaskDependency(value, availableTaskPaths)?.name ?? null;
}

function normalizeTaskDependenciesInContent(content, availableTaskPaths) {
    const match = content.match(/^Depends on:\s+(.+)$/m);
    if (!match || match[1].trim().toLowerCase() === 'none') return { content, repairs: [] };
    const values = match[1].split(',').map((value) => value.trim()).filter(Boolean);
    const resolutions = values.map((value) => resolveTaskDependency(value, availableTaskPaths));
    if (resolutions.some((resolution) => !resolution)) return { content, repairs: [] };
    const repairs = resolutions.flatMap((resolution, index) => (
        resolution.repaired ? [{ from: values[index], to: resolution.name }] : []
    ));
    if (repairs.length === 0) return { content, repairs };

    const normalizedValues = resolutions.map((resolution, index) => (
        resolution.repaired ? resolution.name : values[index]
    ));
    const replacement = `Depends on: ${normalizedValues.join(', ')}`;
    const nextContent = `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
    return { content: nextContent, repairs };
}

function repairTaskDependencies(taskPath) {
    const { absolutePath } = taskFile(taskPath);

    const originalContent = readFileSync(absolutePath, 'utf8');
    const normalized = normalizeTaskDependenciesInContent(originalContent);
    if (normalized.repairs.length > 0) writeFileSync(absolutePath, normalized.content);
    return normalized.repairs;
}

function parseTask(taskPath, requireTodo = true) {
    const absolutePath = resolve(root, taskPath);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (requireTodo && !relativePath.startsWith('kanban/todo/')) fail([`TASK_NOT_IN_TODO: ${relativePath}`]);
    const taskPathError = regularProjectFileError(relativePath);
    if (taskPathError === 'path does not exist') fail([`TASK_MISSING: ${relativePath}`]);
    if (taskPathError) fail([`TASK_FILE_INVALID: ${relativePath}; ${taskPathError}`]);

    const content = readFileSync(absolutePath, 'utf8');
    const scopeBlock = content.match(/## (?:Allowed scope|Scope)\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const contextBlock = content.match(/## Context\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const verifyBlock = content.match(/## Verify\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const memoryBlock = content.match(/## Memory\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const outcomeBlock = content.match(/## Outcome\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const requirementsBlock = content.match(/## Requirements\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const schedulingBlock = content.match(/## Scheduling\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const allowedScopeEntries = parseScopeEntries(scopeBlock);
    const invalidScopeEntries = allowedScopeEntries
        .map(({ path }) => ({ path, error: scopePathFormatError(path) }))
        .filter(({ error }) => error);
    if (invalidScopeEntries.length > 0) {
        fail(invalidScopeEntries.map(({ path, error }) => (
            `TASK_FORMAT: Scope entry must contain only one exact project-relative path: ${path}; ${error}`
        )));
    }
    const allowedScope = withPackageCompanions(allowedScopeEntries.map(({ path }) => path));
    const { paths: contextPaths, invalidLines: invalidContextLines } = parseContextEntries(contextBlock);
    if (invalidContextLines.length > 0) {
        fail(invalidContextLines.map((line) => `TASK_FORMAT: Context entry must be one exact project-relative path: ${line}`));
    }
    const invalidContextPaths = contextPaths
        .map((path) => ({ path, error: contextPathError(path) }))
        .filter(({ error }) => error);
    if (invalidContextPaths.length > 0) {
        fail(invalidContextPaths.map(({ path, error }) => `CONTEXT_PATH_INVALID: ${path}; ${error}`));
    }
    const scopedContextPaths = contextPaths.filter((path) => (
        allowedScope.some((scope) => path === scope || path.startsWith(`${scope}/`))
    ));
    if (scopedContextPaths.length > 0) {
        fail(scopedContextPaths.map((path) => `CONTEXT_PATH_IN_SCOPE: ${path}; Context is read-only and must not enter mutation Scope`));
    }
    const commands = parseVerifyCommands(verifyBlock);
    const memoryAction = memoryBlock.match(/^Action:\s+`?(none|append|update|remove)`?\s*$/m)?.[1];
    const memoryReason = memoryBlock.match(/^Reason:\s+(.+)$/m)?.[1]?.trim();
    const parallel = schedulingBlock.match(/^Parallel:\s+`?(allowed|denied)`?\s*$/m)?.[1] ?? 'denied';
    const dependenciesValue = schedulingBlock.match(/^Depends on:\s+(.+)$/m)?.[1]?.trim() ?? 'none';
    const resourcesValue = schedulingBlock.match(/^Resources:\s+(.+)$/m)?.[1]?.trim() ?? 'repo';
    const dependencyValues = dependenciesValue.toLowerCase() === 'none'
        ? []
        : dependenciesValue.split(',').map((value) => value.trim()).filter(Boolean);
    const dependencies = dependencyValues.map((value) => {
        const normalized = normalizeTaskDependency(value);
        if (!normalized) fail([`TASK_FORMAT: ${relativePath}: dependency must be an exact .md task filename or exact Kanban task path: ${value}`]);
        return normalized;
    });
    const resources = resourcesValue.toLowerCase() === 'none'
        ? []
        : resourcesValue.split(',').map((value) => value.trim().replace(/^`|`$/g, '')).filter(Boolean);
    if (allowedScope.length === 0) fail(['TASK_FORMAT: Allowed scope needs at least one exact backticked path']);
    if (!memoryAction) fail(['TASK_FORMAT: Memory needs Action: `none|append|update|remove`']);
    if (!memoryReason || memoryReason.includes('<')) fail(['TASK_FORMAT: Memory needs a concrete one-line Reason']);
    for (const entry of allowedScopeEntries) {
        const absoluteScopePath = resolve(root, entry.path);
        if (
            !entry.isNew
            && !existsSync(absoluteScopePath)
            && !scopePathExistedAtActiveTaskStart(entry.path, relativePath, hash(content))
        ) {
            fail([`SCOPE_PATH_MISSING: ${entry.path}; correct the path or mark it as NEW`]);
        }
    }
    if (memoryAction !== 'none' && !allowedScope.includes('MEMORY.md')) {
        fail([`TASK_FORMAT: Memory action ${memoryAction} requires MEMORY.md in Allowed scope`]);
    }
    if (memoryAction === 'none' && allowedScope.includes('MEMORY.md')) {
        fail(['TASK_FORMAT: Memory action none must not include MEMORY.md in Allowed scope']);
    }
    if (schedulingBlock && !schedulingBlock.match(/^Parallel:\s+`?(allowed|denied)`?\s*$/m)) {
        fail([`TASK_FORMAT: ${relativePath}: Scheduling needs Parallel: allowed or denied`]);
    }
    if (schedulingBlock && !schedulingBlock.match(/^Depends on:\s+.+$/m)) {
        fail([`TASK_FORMAT: ${relativePath}: Scheduling needs Depends on: none or exact .md task filenames`]);
    }
    if (schedulingBlock && !schedulingBlock.match(/^Resources:\s+.+$/m)) {
        fail([`TASK_FORMAT: ${relativePath}: Scheduling needs Resources: none or comma-separated names`]);
    }
    for (const dependency of dependencies) {
        if (dependency === relativePath.split('/').pop()) fail([`TASK_FORMAT: ${relativePath}: task cannot depend on itself: ${dependency}`]);
        if (!existsSync(resolve(root, 'kanban/todo', dependency)) && !existsSync(resolve(root, 'kanban/done', dependency))) {
            fail([`TASK_DEPENDENCY_MISSING: ${relativePath}: ${dependency}`]);
        }
    }
    const verifyCommandErrors = [];
    for (const { command } of commands) {
        const formatError = verifyCommandFormatError(command);
        if (formatError) verifyCommandErrors.push(formatError);
        verifyCommandErrors.push(...verifyNpmScriptErrors(command));
        if (forbiddenCommand.test(command)) verifyCommandErrors.push(`FORBIDDEN_VERIFY_COMMAND: ${command}`);
    }
    if (verifyCommandErrors.length > 0) fail(verifyCommandErrors);
    return {
        absolutePath,
        relativePath,
        name: relativePath.split('/').pop(),
        contentHash: hash(content),
        allowedScope,
        allowedScopeEntries,
        contextPaths,
        commands,
        memoryAction,
        memoryReason,
        scheduling: { parallel, dependencies, resources },
    };
}

function taskFile(taskPath) {
    const absolutePath = resolve(root, taskPath);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!relativePath.startsWith('kanban/todo/')) fail([`TASK_NOT_IN_TODO: ${relativePath}`]);
    const taskPathError = regularProjectFileError(relativePath);
    if (taskPathError === 'path does not exist') fail([`TASK_MISSING: ${relativePath}`]);
    if (taskPathError) fail([`TASK_FILE_INVALID: ${relativePath}; ${taskPathError}`]);
    return { absolutePath, relativePath, name: relativePath.split('/').pop(), contentHash: fileHash(absolutePath) };
}

function lintPath(task) {
    return resolve(lintsDirectory, `${task.name}.json`);
}

function registrationPath(task) {
    return resolve(registrationsDirectory, `${task.name}.json`);
}

function taskRegistrationValid(task) {
    if (!existsSync(registrationPath(task))) return false;
    try {
        const registration = JSON.parse(readFileSync(registrationPath(task), 'utf8'));
        return registration.status === 'registered' && registration.taskHash === task.contentHash;
    } catch {
        return false;
    }
}

function scopePathExistedAtActiveTaskStart(path, taskPath, taskHash) {
    if (!existsSync(statePath)) return false;
    try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (!['started', 'passed'].includes(state.status)) return false;
        if (state.taskPath !== taskPath || state.taskHash !== taskHash) return false;
        if (matchesFilesystemIgnore(path)) return true;
        return Object.keys(state.snapshot ?? {}).some((snapshotPath) => (
            snapshotPath === path || snapshotPath.startsWith(`${path}/`)
        ));
    } catch {
        return false;
    }
}

function registeredPeerTaskChange(path, activeTaskPath) {
    if (path === activeTaskPath) return false;
    const match = path.match(/^kanban\/(?:todo|done)\/([^/]+\.md)$/);
    if (match) {
        const candidates = [`kanban/todo/${match[1]}`, `kanban/done/${match[1]}`]
            .filter((candidate) => existsSync(resolve(root, candidate)));
        if (candidates.length === 1) {
            const absolutePath = resolve(root, candidates[0]);
            const task = {
                name: match[1],
                contentHash: fileHash(absolutePath),
            };
            if (taskRegistrationValid(task)) return true;
        }
    }

    if (!existsSync(reportsDirectory)) return false;
    let currentHash = null;
    if (existsSync(resolve(root, path))) {
        try {
            const stats = lstatSync(resolve(root, path));
            if (!stats.isFile() || stats.isSymbolicLink()) return false;
            currentHash = fileHash(resolve(root, path));
        } catch {
            return false;
        }
    }
    for (const reportName of readdirSync(reportsDirectory).filter((name) => name.endsWith('.json'))) {
        try {
            const report = JSON.parse(readFileSync(resolve(reportsDirectory, reportName), 'utf8'));
            if (report?.status !== 'passed' || !/^kanban\/todo\/[^/]+\.md$/.test(report?.taskPath)) continue;
            if (report.taskPath === activeTaskPath || !Object.hasOwn(report?.changedFileHashes ?? {}, path)) continue;
            if (report.changedFileHashes[path] !== currentHash) continue;
            const name = report.taskPath.split('/').pop();
            const donePath = resolve(root, 'kanban/done', name);
            if (!existsSync(donePath)) continue;
            if (taskRegistrationValid({ name, contentHash: fileHash(donePath) })) return true;
        } catch {
            // Invalid or stale reports never authorize pre-start drift.
        }
    }
    return false;
}

function hasTechnicalOperationEvidence(report) {
    const changedFiles = Array.isArray(report?.changedFiles)
        ? report.changedFiles.filter((path) => typeof path === 'string' && path.length > 0)
        : [];
    const successfulCommands = Array.isArray(report?.commands)
        ? report.commands.filter((entry) => (
            entry
            && Number.isInteger(entry.expectedExit)
            && Number.isInteger(entry.actualExit)
            && entry.actualExit === entry.expectedExit
        ))
        : [];
    return changedFiles.length > 0 || successfulCommands.length > 0;
}

function readJson(path, missingMessage) {
    if (!existsSync(path)) fail([missingMessage]);
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        fail([`INVALID_JSON: ${error instanceof Error ? error.message : path}`]);
    }
}

function lint(taskPath) {
    const repairs = repairTaskDependencies(taskPath);
    const task = parseTask(taskPath);
    mkdirSync(lintsDirectory, { recursive: true });
    writeFileSync(lintPath(task), `${JSON.stringify({
        version: 1,
        status: 'linted',
        taskPath: task.relativePath,
        finalTaskHash: task.contentHash,
        lintedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    for (const repair of repairs) console.log(`TASK DOCTOR: REPAIRED DEPENDENCY ${repair.from} -> ${repair.to}`);
    console.log(`TASK DOCTOR: LINT PASS ${task.relativePath}`);
}

function register(taskPath) {
    const task = parseTask(taskPath);
    const lintData = readJson(lintPath(task), 'LINT_MISSING: run task:doctor:lint first');
    const errors = [];
    if (lintData.status !== 'linted') errors.push(`LINT_STATE: expected linted, found ${lintData.status}`);
    if (lintData.finalTaskHash !== task.contentHash) errors.push('TASK_CHANGED_AFTER_LINT: lint the current task version again');
    if (errors.length) fail(errors);
    mkdirSync(registrationsDirectory, { recursive: true });
    const registration = {
        version: 1,
        status: 'registered',
        mode: gitMode ? 'git' : 'filesystem',
        taskPath: task.relativePath,
        taskHash: task.contentHash,
        head: gitMode ? git('rev-parse', 'HEAD').trim() : null,
        indexHash: indexHash(),
        snapshot: snapshot(),
        memory: memoryState(),
        memoryContent: existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '',
        memoryAction: task.memoryAction,
        memoryReason: task.memoryReason,
        lint: { lintedAt: lintData.lintedAt, finalTaskHash: lintData.finalTaskHash },
        registeredAt: new Date().toISOString(),
    };
    writeFileSync(registrationPath(task), `${JSON.stringify(registration, null, 2)}\n`);
    console.log(`TASK DOCTOR: REGISTERED ${task.relativePath}`);
}

function memoryState() {
    return existsSync(memoryPath)
        ? { exists: true, hash: fileHash(memoryPath), size: readFileSync(memoryPath).length }
        : { exists: false, hash: null, size: 0 };
}

function walk(directory, files = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.DS_Store') continue;
        const absolutePath = resolve(directory, entry.name);
        const relativePath = normalizePath(relative(root, absolutePath));
        if (matchesFilesystemIgnore(relativePath)) continue;
        if (entry.isDirectory()) {
            if (!ignoredDirectories.has(entry.name)) walk(absolutePath, files);
        } else if (entry.isFile()) files.push(relativePath);
    }
    return files;
}

function snapshot() {
    return Object.fromEntries(walk(root).map((path) => [path, fileHash(resolve(root, path))]));
}

function snapshotHash(value) {
    return hash(JSON.stringify(value, Object.keys(value).sort()));
}

function indexHash() {
    return gitMode ? hash(git('diff', '--cached', '--binary')) : null;
}

function pathAllowed(path, allowedScope, taskPath) {
    if (path === taskPath) return true;
    return allowedScope.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function changedPaths(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((path) => before[path] !== after[path])
        .sort();
}

function projectDirectorySet(directory = root, directories = new Set()) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
        const absolutePath = resolve(directory, entry.name);
        const relativePath = normalizePath(relative(root, absolutePath));
        if (matchesFilesystemIgnore(relativePath)) continue;
        directories.add(relativePath);
        projectDirectorySet(absolutePath, directories);
    }
    return directories;
}

function captureTaskScopeFiles(snapshotValue, task) {
    return new Map(Object.keys(snapshotValue)
        .filter((path) => pathAllowed(path, task.allowedScope, task.relativePath))
        .map((path) => [path, readFileSync(resolve(root, path))]));
}

function removeProjectEntryWithoutFollowingSymlinks(path) {
    let current = root;
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
        const next = resolve(current, segments[index]);
        let stats;
        try {
            stats = lstatSync(next);
        } catch {
            return;
        }
        if (index < segments.length - 1 && stats.isDirectory() && !stats.isSymbolicLink()) {
            current = next;
            continue;
        }
        rmSync(next, { recursive: true, force: true });
        return;
    }
}

function ensureProjectParentDirectories(path) {
    let current = root;
    for (const segment of dirname(path).split('/').filter((value) => value && value !== '.')) {
        const next = resolve(current, segment);
        let stats = null;
        try {
            stats = lstatSync(next);
        } catch {
            // Missing parents are recreated below.
        }
        if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
            rmSync(next, { recursive: true, force: true });
            stats = null;
        }
        if (!stats) mkdirSync(next);
        current = next;
    }
}

function restoreVerifyTaskFiles(paths, backups, directoriesBefore) {
    const errors = [];
    const createdParents = new Set();
    for (const path of paths.filter((candidate) => !backups.has(candidate))) {
        let parent = normalizePath(dirname(path));
        while (parent && parent !== '.') {
            if (!directoriesBefore.has(parent)) createdParents.add(parent);
            const next = normalizePath(dirname(parent));
            if (next === parent) break;
            parent = next;
        }
        try {
            removeProjectEntryWithoutFollowingSymlinks(path);
        } catch (error) {
            errors.push(`VERIFY_RESTORE_FAILED: ${path}; ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const path of paths.filter((candidate) => backups.has(candidate))) {
        try {
            ensureProjectParentDirectories(path);
            removeProjectEntryWithoutFollowingSymlinks(path);
            writeFileSync(resolve(root, path), backups.get(path));
        } catch (error) {
            errors.push(`VERIFY_RESTORE_FAILED: ${path}; ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const path of [...createdParents].sort((left, right) => right.split('/').length - left.split('/').length)) {
        try {
            const stats = lstatSync(resolve(root, path));
            if (stats.isDirectory() && !stats.isSymbolicLink() && readdirSync(resolve(root, path)).length === 0) {
                rmSync(resolve(root, path), { recursive: true, force: true });
            }
        } catch {
            // Already absent is the desired restored state.
        }
    }
    return errors;
}

function readAuthorizedCustomChanges() {
    if (!existsSync(authorizedCustomChangesPath)) return [];
    try {
        const value = JSON.parse(readFileSync(authorizedCustomChangesPath, 'utf8'));
        if (value?.version !== 1 || !Array.isArray(value.changes)) return [];
        return value.changes.filter((entry) => (
            (entry?.beforeHash === null || typeof entry?.beforeHash === 'string')
            && typeof entry?.afterHash === 'string'
            && typeof entry?.violationID === 'string'
        ));
    } catch {
        return [];
    }
}

function readAuthorizedMemoryChanges() {
    if (!existsSync(authorizedMemoryChangesPath)) return [];
    try {
        const value = JSON.parse(readFileSync(authorizedMemoryChangesPath, 'utf8'));
        if (value?.version !== 1 || !Array.isArray(value.changes)) return [];
        return value.changes.filter((entry) => (
            entry?.path === 'MEMORY.md'
            && (entry.beforeHash === null || typeof entry.beforeHash === 'string')
            && typeof entry.afterHash === 'string'
            && typeof entry.recoveryID === 'string'
        ));
    } catch {
        return [];
    }
}

function readAuthorizedHarnessChanges() {
    if (!existsSync(authorizedHarnessChangesPath)) return [];
    try {
        const value = JSON.parse(readFileSync(authorizedHarnessChangesPath, 'utf8'));
        if (value?.version !== 1 || !Array.isArray(value.changes)) return [];
        return value.changes.filter((entry) => (
            typeof entry?.path === 'string'
            && (entry.beforeHash === null || typeof entry.beforeHash === 'string')
            && typeof entry.afterHash === 'string'
            && typeof entry.recoveryID === 'string'
        ));
    } catch {
        return [];
    }
}

function readAuthorizedChanges() {
    return [...readAuthorizedCustomChanges(), ...readAuthorizedMemoryChanges(), ...readAuthorizedHarnessChanges()];
}

function authorizedRuleTransition(path, beforeHash, afterHash, changes = readAuthorizedChanges()) {
    const start = beforeHash ?? null;
    const target = afterHash ?? null;
    if (start === target) return true;
    if (target === null) return false;

    const reachable = new Set([start]);
    let advanced = true;
    while (advanced) {
        advanced = false;
        for (const entry of changes) {
            if ((entry.path ?? 'CUSTOM.md') !== path) continue;
            if (!reachable.has(entry.beforeHash) || reachable.has(entry.afterHash)) continue;
            reachable.add(entry.afterHash);
            advanced = true;
        }
    }
    return reachable.has(target);
}

function relevantChangedPaths(before, after, authorizedChanges = readAuthorizedChanges()) {
    return changedPaths(before, after).filter((path) => {
        if (matchesFilesystemIgnore(path)) return false;
        return !authorizedRuleTransition(path, before[path], after[path], authorizedChanges);
    });
}

function taskRelevantChangedPaths(before, after, task) {
    const changed = relevantChangedPaths(before, after);
    return task.memoryAction === 'none' ? changed.filter((path) => path !== 'MEMORY.md') : changed;
}

function hasPath(snapshotValue, path) {
    return Object.prototype.hasOwnProperty.call(snapshotValue, path);
}

function outsideScopeFindings(before, after, allowedScope, taskPath, whitelistedFiles = [], ignoredPaths = []) {
    const errors = [];
    const whitelist = new Map(whitelistedFiles.map((entry) => [entry.path, entry]));
    const ignored = new Set(ignoredPaths);
    let hasUnknown = false;
    let hasMissing = false;
    let hasChanged = false;

    for (const entry of whitelistedFiles) {
        if (!hasPath(after, entry.path)) errors.push(`WHITELISTED_FILE_MISSING: ${entry.path}`);
        else if (after[entry.path] !== entry.hash) errors.push(`WHITELISTED_FILE_CHANGED: ${entry.path}`);
    }

    for (const path of relevantChangedPaths(before, after)) {
        if (ignored.has(path) || matchesFilesystemIgnore(path)) continue;
        if (pathAllowed(path, allowedScope, taskPath) || whitelist.has(path)) continue;
        if (!hasPath(before, path)) {
            errors.push(`UNKNOWN_FILE: ${path}`);
            hasUnknown = true;
        } else if (!hasPath(after, path)) {
            errors.push(`MISSING_OUTSIDE_SCOPE_FILE: ${path}`);
            hasMissing = true;
        } else {
            errors.push(`CHANGED_OUTSIDE_SCOPE_FILE: ${path}`);
            hasChanged = true;
        }
    }

    if (hasUnknown) {
        errors.push(`UNKNOWN_FILE_ACTION: inspect each exact path. For disposable test data, run npm run task:doctor:test-file -- ${taskPath} <path>; Doctor will register and remove it. To keep an intentional non-test file, run npm run task:doctor:whitelist -- ${taskPath} <path> "<specific reason>". Then rerun Doctor verify.`);
    }
    if (hasMissing) errors.push('MISSING_FILE_ACTION: restore the exact original file bytes. Do not create a placeholder. If the original is unavailable, stop and report the blocker.');
    if (hasChanged) errors.push('CHANGED_FILE_ACTION: restore the exact original file bytes. If the change is intentional implementation work, stop and report that the task Scope is insufficient.');
    if (errors.some((error) => error.startsWith('WHITELISTED_FILE_'))) {
        errors.push('WHITELIST_ACTION: restore the whitelisted file to its recorded content or stop and report the blocker.');
    }
    return errors;
}

function executorHarnessDrift(before, after, allowedScope, taskPath) {
    if (!executorBaselineRecoveryEnabled) return [];
    return relevantChangedPaths(before, after).filter((path) => (
        !pathAllowed(path, allowedScope, taskPath)
        && matchesExecutorRecoveryPath(path)
        && hasPath(after, path)
    ));
}

function failExecutorHarnessRecovery(state, task, currentSnapshot, paths, beforeSnapshot = state.snapshot) {
    const detectedAt = new Date().toISOString();
    const recovery = {
        status: 'required',
        code: 'HARNESS_BASELINE_DRIFT',
        taskPath: task.relativePath,
        taskHash: task.contentHash,
        paths: paths.map((path) => ({
            path,
            beforeHash: beforeSnapshot[path] ?? null,
            afterHash: currentSnapshot[path],
        })),
        detectedAt,
    };
    writeState({ ...state, executorRecovery: recovery });
    console.error('TASK DOCTOR: EXECUTOR RECOVERY REQUIRED');
    for (const path of paths) console.error(`- HARNESS_BASELINE_DRIFT: ${path}`);
    console.error('- RECOVERY_OWNER: Worker must stop and return BLOCKED with Required owner: Executor.');
    console.error(`- EXECUTOR_ACTION: inspect readable listed paths, treat WORKER rule files as opaque, then call recover_harness_baseline for ${task.relativePath} with exactly all listed paths. Do not return this blocker to Planner or another Worker.`);
    process.exit(1);
}

function findGeneratedArtifacts() {
    const artifacts = [];
    function visit(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (operationalDirectoryNames.has(entry.name)) continue;
            const absolutePath = resolve(directory, entry.name);
            const relativePath = normalizePath(relative(root, absolutePath));
            if (!entry.isDirectory()) continue;
            if (
                generatedNames.has(entry.name) &&
                readdirSync(absolutePath).length > 0 &&
                !isIgnored(relativePath)
            ) artifacts.push(relativePath);
            else visit(absolutePath);
        }
    }
    visit(root);
    return artifacts.sort();
}

function readState() {
    if (!existsSync(statePath)) fail(['STATE_MISSING: run task:doctor:start first']);
    return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(state) {
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function schedulingConflict(left, right) {
    const scopeOverlap = left.allowedScope.some((leftPath) => right.allowedScope.some((rightPath) => (
        leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`)
    )));
    const sharedResource = left.scheduling.resources.some((resource) => right.scheduling.resources.includes(resource));
    return scopeOverlap || sharedResource;
}

function schedulingPlan() {
    const active = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    if (active?.status === 'started' || active?.status === 'passed') {
        return { active: active.taskPath, activeStatus: active.status, ready: [], blocked: [] };
    }

    const tasks = readdirSync(resolve(root, 'kanban/todo'))
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => parseTask(`kanban/todo/${name}`));
    const doneDirectory = resolve(root, 'kanban/done');
    const done = new Set(existsSync(doneDirectory) ? readdirSync(doneDirectory).filter((name) => name.endsWith('.md')) : []);
    const blocked = [];
    const candidates = [];

    for (const task of tasks) {
        if (!taskRegistrationValid(task)) {
            blocked.push({ task: task.relativePath, reason: 'not registered' });
            continue;
        }
        const missingDependencies = task.scheduling.dependencies.filter((dependency) => !done.has(dependency));
        if (missingDependencies.length > 0) {
            blocked.push({ task: task.relativePath, reason: `waiting for ${missingDependencies.join(', ')}` });
            continue;
        }
        candidates.push(task);
    }

    candidates.sort((left, right) => left.name.localeCompare(right.name));
    const ready = [];
    for (const task of candidates) {
        if (ready.length >= workerPoolSettings.maxConcurrentWorkers) break;
        if (task.scheduling.parallel === 'denied') {
            if (ready.length === 0) ready.push(task);
            else blocked.push({ task: task.relativePath, reason: 'requires exclusive Worker' });
            break;
        }
        const conflict = ready.find((selected) => schedulingConflict(task, selected));
        if (conflict) {
            blocked.push({ task: task.relativePath, reason: `conflicts with ${conflict.name}` });
            continue;
        }
        ready.push(task);
    }
    return { active: null, activeStatus: null, ready, blocked };
}

function printSchedule() {
    console.log(`TASK DOCTOR: WORKER LIMIT ${workerPoolSettings.maxConcurrentWorkers}`);
    const memoryRecovery = memoryLimitStatus();
    if (memoryRecovery) {
        console.log('TASK DOCTOR: EXECUTOR RECOVERY REQUIRED');
        console.log(`- ${memoryRecoveryMessage(memoryRecovery)}`);
        console.log('- RECOVERY_OWNER: Executor must read MEMORY.md, preserve durable facts, and call recover_project_memory before delegation or completion.');
        const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
        if (state?.status === 'started' || state?.status === 'passed') console.log(`TASK DOCTOR: ACTIVE ${state.taskPath}`);
        return;
    }
    const plan = schedulingPlan();
    if (plan.active) {
        console.log(`TASK DOCTOR: ACTIVE ${plan.active}`);
        return;
    }
    if (plan.ready.length === 0) console.log('TASK DOCTOR: NO READY TASKS');
    for (const task of plan.ready) console.log(`TASK DOCTOR: READY ${task.relativePath}`);
    for (const entry of plan.blocked) console.log(`TASK DOCTOR: BLOCKED ${entry.task} - ${entry.reason}`);
}

function nextTask() {
    const memoryRecovery = memoryLimitStatus();
    if (memoryRecovery) {
        console.log('TASK DOCTOR: EXECUTOR RECOVERY REQUIRED');
        console.log(`- ${memoryRecoveryMessage(memoryRecovery)}`);
        return;
    }
    const plan = schedulingPlan();
    const next = plan.ready[0];
    if (!next) {
        console.log('TASK DOCTOR: NO TASKS');
        return;
    }
    console.log(next.relativePath);
}

function start(taskPath) {
    const memoryRecovery = memoryLimitStatus();
    if (memoryRecovery) failExecutorMemoryRecovery(memoryRecovery);
    const task = parseTask(taskPath);
    const ready = schedulingPlan().ready.map(({ relativePath }) => relativePath);
    if (!ready.includes(task.relativePath)) {
        fail([`TASK_ORDER: ${task.relativePath} is not ready; run task:doctor:schedule`]);
    }
    const registration = readJson(registrationPath(task), 'REGISTRATION_MISSING: run task:doctor:register before execution');
    const errors = [];
    if (registration.status !== 'registered') errors.push(`REGISTRATION_STATE: expected registered, found ${registration.status}`);
    if (registration.taskHash !== task.contentHash) errors.push('TASK_CHANGED_AFTER_REGISTRATION: inspect, lint, and register again');
    if (registration.mode !== (gitMode ? 'git' : 'filesystem')) errors.push(`MODE_CHANGED: registered in ${registration.mode} mode`);
    if (gitMode && registration.head !== git('rev-parse', 'HEAD').trim()) errors.push('GIT_HISTORY_CHANGED_AFTER_REGISTRATION');
    if (gitMode && registration.indexHash !== indexHash()) errors.push('GIT_INDEX_CHANGED_AFTER_REGISTRATION');
    const currentSnapshot = snapshot();
    const prestartChanges = relevantChangedPaths(registration.snapshot, currentSnapshot)
        .filter((path) => !registeredPeerTaskChange(path, task.relativePath));
    const recoveryPaths = prestartChanges.filter((path) => matchesExecutorRecoveryPath(path) && hasPath(currentSnapshot, path));
    for (const path of prestartChanges.filter((path) => !recoveryPaths.includes(path))) errors.push(`PRESTART_CHANGE: ${path}`);
    if (errors.length) fail(errors);

    const startedState = {
        ...registration,
        version: 4,
        status: 'started',
        snapshot: currentSnapshot,
        whitelistedFiles: [],
        testFiles: [],
        startedAt: new Date().toISOString(),
    };
    if (recoveryPaths.length) {
        failExecutorHarnessRecovery(startedState, task, currentSnapshot, recoveryPaths, registration.snapshot);
    }
    writeState(startedState);
    console.log(`TASK DOCTOR: STARTED ${task.relativePath}`);
    console.log(`TASK DOCTOR: MODE ${gitMode ? 'git' : 'filesystem'}`);
    console.log(`TASK DOCTOR: MEMORY LOADED action=${task.memoryAction} sha256=${memoryState().hash ?? 'missing'} size=${memoryState().size}`);
    if (!gitMode) console.log('TASK DOCTOR: WARNING Git history, index, and .gitignore checks are unavailable');
}

function whitelistFile(taskPath, filePath, reasonParts) {
    const state = readState();
    if (state.status !== 'started') fail([`INVALID_STATE: expected started, found ${state.status}`]);
    const task = parseTask(taskPath);
    if (state.taskPath !== task.relativePath) fail([`TASK_CHANGED: started ${state.taskPath}, whitelisting for ${task.relativePath}`]);
    if (state.taskHash !== task.contentHash) fail(['TASK_MUTATED: task contents changed after start']);

    const absolutePath = resolve(root, filePath);
    const relativePath = normalizePath(relative(root, absolutePath));
    const reason = reasonParts.join(' ').trim();
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) fail([`WHITELIST_PATH_OUTSIDE_PROJECT: ${filePath}`]);
    if (matchesFilesystemIgnore(relativePath)) fail([`WHITELIST_PATH_IGNORED: ${relativePath}`]);
    if (pathAllowed(relativePath, task.allowedScope, task.relativePath)) fail([`WHITELIST_PATH_ALREADY_IN_SCOPE: ${relativePath}`]);
    if (hasPath(state.snapshot, relativePath)) fail([`WHITELIST_NOT_UNKNOWN: ${relativePath}; the path existed at task start and must be restored instead`]);
    if (reason.length < 20 || reason.includes('<') || reason.includes('>')) fail(['WHITELIST_REASON_REQUIRED: provide at least 20 concrete characters without placeholders']);

    const currentSnapshot = snapshot();
    if (!hasPath(currentSnapshot, relativePath)) fail([`WHITELIST_FILE_MISSING: ${relativePath}`]);
    if ((state.whitelistedFiles ?? []).some((entry) => entry.path === relativePath)) fail([`WHITELIST_ALREADY_EXISTS: ${relativePath}`]);
    if ((state.testFiles ?? []).some((entry) => entry.path === relativePath)) fail([`WHITELIST_REGISTERED_AS_TEST_FILE: ${relativePath}`]);
    const entry = {
        path: relativePath,
        hash: currentSnapshot[relativePath],
        reason,
        whitelistedAt: new Date().toISOString(),
    };
    writeState({ ...state, whitelistedFiles: [...(state.whitelistedFiles ?? []), entry] });
    console.log(`TASK DOCTOR: WHITELISTED ${relativePath}`);
    console.log(`Reason: ${reason}`);
}

function cleanupTestFiles(state) {
    const errors = [];
    for (const entry of state.testFiles ?? []) {
        if (hasPath(state.snapshot, entry.path)) {
            errors.push(`TEST_FILE_WAS_PRESENT_AT_START: ${entry.path}`);
            continue;
        }
        const absolutePath = resolve(root, entry.path);
        if (!existsSync(absolutePath)) continue;
        try {
            rmSync(absolutePath, { force: true });
            console.log(`TASK DOCTOR: REMOVED TEST FILE ${entry.path}`);
        } catch (error) {
            errors.push(`TEST_FILE_REMOVE_FAILED: ${entry.path}; ${error instanceof Error ? error.message : 'remove failed'}`);
        }
    }
    if (errors.length > 0) fail(errors);
}

function registerTestFile(taskPath, filePath) {
    const state = readState();
    if (state.status !== 'started') fail([`INVALID_STATE: expected started, found ${state.status}`]);
    const task = parseTask(taskPath);
    if (state.taskPath !== task.relativePath) fail([`TASK_CHANGED: started ${state.taskPath}, registering test data for ${task.relativePath}`]);
    if (state.taskHash !== task.contentHash) fail(['TASK_MUTATED: task contents changed after start']);

    const absolutePath = resolve(root, filePath);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) fail([`TEST_FILE_PATH_OUTSIDE_PROJECT: ${filePath}`]);
    if (matchesFilesystemIgnore(relativePath)) fail([`TEST_FILE_PATH_IGNORED: ${relativePath}`]);
    if (pathAllowed(relativePath, task.allowedScope, task.relativePath)) fail([`TEST_FILE_PATH_IN_SCOPE: ${relativePath}; Doctor will not delete a scoped implementation file`]);
    if (hasPath(state.snapshot, relativePath)) fail([`TEST_FILE_WAS_PRESENT_AT_START: ${relativePath}; restore the original file instead`]);
    if ((state.whitelistedFiles ?? []).some((entry) => entry.path === relativePath)) fail([`TEST_FILE_IS_WHITELISTED: ${relativePath}`]);
    if ((state.testFiles ?? []).some((entry) => entry.path === relativePath)) fail([`TEST_FILE_ALREADY_REGISTERED: ${relativePath}`]);

    const currentSnapshot = snapshot();
    if (!hasPath(currentSnapshot, relativePath)) fail([`TEST_FILE_MISSING: ${relativePath}`]);
    const entry = { path: relativePath, registeredAt: new Date().toISOString() };
    const nextState = { ...state, testFiles: [...(state.testFiles ?? []), entry] };
    writeState(nextState);
    console.log(`TASK DOCTOR: REGISTERED TEST FILE ${relativePath}`);
    cleanupTestFiles(nextState);
}

function verify(taskPath) {
    const preflightOnly = process.env.TASK_DOCTOR_PREFLIGHT === '1';
    const state = readState();
    if (state.status !== 'started') fail([`INVALID_STATE: expected started, found ${state.status}`]);
    const task = parseTask(taskPath);
    const errors = [];
    const ignoredProjectPaths = task.memoryAction === 'none' ? ['MEMORY.md'] : [];
    cleanupTestFiles(state);
    const beforeVerify = snapshot();
    if (state.mode !== (gitMode ? 'git' : 'filesystem')) errors.push(`MODE_CHANGED: started in ${state.mode} mode`);
    if (state.taskPath !== task.relativePath) errors.push(`TASK_CHANGED: started ${state.taskPath}, verifying ${task.relativePath}`);
    if (state.taskHash !== task.contentHash) errors.push('TASK_MUTATED: task contents changed after start');
    if (state.memoryAction !== task.memoryAction) errors.push('MEMORY_ACTION_CHANGED: task memory decision changed after start');
    if (gitMode && state.head !== git('rev-parse', 'HEAD').trim()) errors.push('GIT_HISTORY_CHANGED: HEAD changed during the task');
    if (gitMode && state.indexHash !== indexHash()) errors.push('GIT_INDEX_CHANGED: staged changes changed during the task');

    const harnessDrift = executorHarnessDrift(state.snapshot, beforeVerify, task.allowedScope, task.relativePath);
    if (harnessDrift.length > 0) failExecutorHarnessRecovery(state, task, beforeVerify, harnessDrift);

    errors.push(...outsideScopeFindings(state.snapshot, beforeVerify, task.allowedScope, task.relativePath, state.whitelistedFiles ?? [], ignoredProjectPaths));
    const currentMemory = memoryState();
    const memoryChanged = state.memory.exists !== currentMemory.exists || state.memory.hash !== currentMemory.hash;
    if (task.memoryAction !== 'none' && !memoryChanged) errors.push(`MEMORY_REQUIRED_CHANGE: Action ${task.memoryAction} requires a MEMORY.md change`);
    if (task.memoryAction === 'append' && memoryChanged) {
        const currentContent = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '';
        if (!currentContent.startsWith(state.memoryContent)) errors.push('MEMORY_APPEND_REWROTE_HISTORY: append may only add content at the end');
    }
    const taskOwnedMemoryLimit = task.memoryAction !== 'none' ? memoryLimitStatus() : null;
    if (taskOwnedMemoryLimit) errors.push(memoryRecoveryMessage(taskOwnedMemoryLimit));
    if (errors.length > 0) fail(errors);

    const taskScopeBackups = captureTaskScopeFiles(beforeVerify, task);
    const directoriesBeforeVerify = projectDirectorySet();
    const verifyStateBefore = collectVerifyState();
    const commandResults = [];
    const commandErrors = [];
    for (const { command, expectedExit } of task.commands) {
        console.log(`TASK DOCTOR: RUN ${command}`);
        const startedAt = Date.now();
        const result = run(command, [], { shell: true, maxBuffer: 20 * 1024 * 1024 });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        commandResults.push({
            command,
            expectedExit,
            actualExit: result.status,
            durationMs: Date.now() - startedAt,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
        });
        if (result.status !== expectedExit) {
            commandErrors.push(`VERIFY_FAILED: expected exit ${expectedExit}, got ${result.status ?? 'signal'}: ${command}`);
            break;
        }
    }

    const afterVerifyCommands = snapshot();
    const verifyTaskMutations = changedPaths(beforeVerify, afterVerifyCommands)
        .filter((path) => pathAllowed(path, task.allowedScope, task.relativePath));
    const verifyRestoreErrors = restoreVerifyTaskFiles(verifyTaskMutations, taskScopeBackups, directoriesBeforeVerify);
    const afterVerifyRestore = snapshot();
    const unrestoredTaskMutations = changedPaths(beforeVerify, afterVerifyRestore)
        .filter((path) => pathAllowed(path, task.allowedScope, task.relativePath));
    const verifyMutationErrors = verifyTaskMutations.map((path) => (
        `VERIFY_MUTATED_TASK_FILE: ${path}; Verify commands must leave task-scope files unchanged; Doctor restored the pre-Verify state`
    ));
    verifyRestoreErrors.push(...unrestoredTaskMutations
        .filter((path) => !verifyRestoreErrors.some((error) => error.startsWith(`VERIFY_RESTORE_FAILED: ${path};`)))
        .map((path) => `VERIFY_RESTORE_FAILED: ${path}; pre-Verify state could not be restored`));

    cleanupTestFiles(state);
    const verifyStateAfter = collectVerifyState();
    const verifyStateErrors = changedVerifyState(verifyStateBefore, verifyStateAfter)
        .map((entry) => `VERIFY_STATE_CHANGED: ${entry.type} ${entry.path}; tests must restore persistent state`);
    if (commandErrors.length > 0 || verifyStateErrors.length > 0 || verifyMutationErrors.length > 0 || verifyRestoreErrors.length > 0) {
        fail([...commandErrors, ...verifyMutationErrors, ...verifyRestoreErrors, ...verifyStateErrors]);
    }

    const verifiedSnapshot = snapshot();
    const verifiedMemoryLimit = task.memoryAction !== 'none' ? memoryLimitStatus() : null;
    if (verifiedMemoryLimit) fail([memoryRecoveryMessage(verifiedMemoryLimit)]);
    const postErrors = outsideScopeFindings(beforeVerify, verifiedSnapshot, task.allowedScope, task.relativePath, state.whitelistedFiles ?? [], ignoredProjectPaths);
    const missingNewPaths = task.allowedScopeEntries
        .filter((entry) => entry.isNew && !existsSync(resolve(root, entry.path)))
        .map((entry) => `NEW_SCOPE_PATH_MISSING: ${entry.path}; create the declared path before PASS`);
    postErrors.push(...missingNewPaths);
    if (gitMode && state.indexHash !== indexHash()) postErrors.push('GIT_INDEX_CHANGED: verification staged files');
    if (postErrors.length > 0) fail(postErrors);

    const changedFiles = taskRelevantChangedPaths(state.snapshot, verifiedSnapshot, task);
    if (!preflightOnly && !hasTechnicalOperationEvidence({ changedFiles, commands: commandResults })) {
        fail(['NO_TECHNICAL_OPERATION: PASS requires at least one in-scope changed path or one successful Verify command']);
    }

    const projectMemoryLimit = task.memoryAction === 'none' ? memoryLimitStatus() : null;
    const executorRecovery = projectMemoryLimit
        ? { status: 'required', owner: 'executor', ...projectMemoryLimit }
        : null;
    if (preflightOnly) {
        console.log('TASK DOCTOR: PREFLIGHT PASS');
        if (executorRecovery) {
            console.log('TASK DOCTOR: EXECUTOR RECOVERY REQUIRED');
            console.log(`- ${memoryRecoveryMessage(executorRecovery)}`);
            console.log('- RECOVERY_OWNER: Executor must call recover_project_memory before implementation. Worker must not edit MEMORY.md.');
        }
        console.log(`TASK DOCTOR: MEMORY ${task.memoryAction}`);
        console.log(`Changed files: ${changedFiles.length ? changedFiles.join(', ') : '(none)'}`);
        return;
    }
    const report = {
        version: 2,
        status: 'passed',
        mode: state.mode,
        memory: {
            action: task.memoryAction,
            reason: task.memoryReason,
            before: state.memory,
            after: memoryState(),
        },
        taskPath: task.relativePath,
        head: state.head,
        changedFiles,
        changedFileHashes: Object.fromEntries(changedFiles.map((path) => [path, verifiedSnapshot[path] ?? null])),
        executorRecovery,
        whitelistedFiles: state.whitelistedFiles ?? [],
        testFiles: state.testFiles ?? [],
        verifyState: {
            status: taskDoctorSettings.verifyState ? 'passed' : 'disabled',
            before: verifyStateBefore,
            after: verifyStateAfter,
        },
        commands: commandResults,
        startedAt: state.startedAt,
        passedAt: new Date().toISOString(),
    };
    mkdirSync(reportsDirectory, { recursive: true });
    const reportPath = resolve(reportsDirectory, `${task.relativePath.split('/').pop()}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    writeState({
        ...state,
        status: 'passed',
        verifiedSnapshot,
        verifiedSnapshotHash: snapshotHash(verifiedSnapshot),
        verifiedIndexHash: gitMode ? indexHash() : null,
        reportPath: normalizePath(relative(root, reportPath)),
        passedAt: report.passedAt,
        executorRecovery,
    });

    console.log('TASK DOCTOR: PASS');
    if (executorRecovery) {
        console.log('TASK DOCTOR: EXECUTOR RECOVERY REQUIRED');
        console.log(`- ${memoryRecoveryMessage(executorRecovery)}`);
        console.log('- RECOVERY_OWNER: Executor must call recover_project_memory before completion. Worker must not edit MEMORY.md.');
    }
    console.log(`TASK DOCTOR: MEMORY ${task.memoryAction}`);
    console.log(`Changed files: ${report.changedFiles.length ? report.changedFiles.join(', ') : '(none)'}`);
}

function complete(taskPath) {
    const state = readState();
    if (state.status !== 'passed') fail([`INVALID_STATE: expected passed, found ${state.status}`]);
    const memoryRecovery = memoryLimitStatus();
    if (memoryRecovery) failExecutorMemoryRecovery(memoryRecovery);
    const task = parseTask(taskPath);
    const errors = [];
    if (state.mode !== (gitMode ? 'git' : 'filesystem')) errors.push(`MODE_CHANGED: passed in ${state.mode} mode`);
    if (state.taskPath !== task.relativePath) errors.push(`TASK_CHANGED: passed ${state.taskPath}, completing ${task.relativePath}`);
    if (state.taskHash !== task.contentHash) errors.push('TASK_MUTATED: task contents changed after start');
    if (gitMode && state.head !== git('rev-parse', 'HEAD').trim()) errors.push('GIT_HISTORY_CHANGED: HEAD changed after PASS');
    if (gitMode && state.verifiedIndexHash !== indexHash()) errors.push('GIT_INDEX_CHANGED: staged changes changed after PASS');
    const currentSnapshot = snapshot();
    if (state.verifiedSnapshot) {
        if (relevantChangedPaths(state.verifiedSnapshot, currentSnapshot).length > 0) errors.push('FILES_CHANGED_AFTER_PASS: rerun the task from start');
    } else if (state.verifiedSnapshotHash !== snapshotHash(currentSnapshot)) {
        errors.push('FILES_CHANGED_AFTER_PASS: rerun the task from start');
    }
    const report = typeof state.reportPath === 'string'
        ? readJson(resolve(root, state.reportPath), 'PASS_REPORT_MISSING: rerun the task from start')
        : null;
    if (!hasTechnicalOperationEvidence(report)) {
        errors.push('NO_TECHNICAL_OPERATION: completion requires an in-scope changed path or a successful Verify command');
    }
    if (errors.length > 0) fail(errors);

    const destination = resolve(root, 'kanban/done', task.relativePath.split('/').pop());
    if (existsSync(destination)) fail([`DONE_TASK_EXISTS: ${normalizePath(relative(root, destination))}`]);
    renameSync(task.absolutePath, destination);
    writeState({ ...state, status: 'completed', completedAt: new Date().toISOString(), destination: normalizePath(relative(root, destination)) });
    console.log(`TASK DOCTOR: COMPLETED ${normalizePath(relative(root, destination))}`);
}

function selfTest() {
    const assertions = [
        [usableGitBaseline(0, 0), 'Git mode requires a worktree with a valid HEAD'],
        [!usableGitBaseline(0, 128), 'an unborn Git repository uses filesystem mode'],
        [!usableGitBaseline(128, 0), 'a directory outside a Git worktree uses filesystem mode'],
        [pathAllowed('src/a.ts', ['src'], 'kanban/todo/x.md'), 'directory scope'],
        [!pathAllowed('other/a.ts', ['src'], 'kanban/todo/x.md'), 'out-of-scope path'],
        [changedPaths({ a: '1' }, { a: '2', b: '1' }).join(',') === 'a,b', 'changed path detection'],
        [outsideScopeFindings({}, { 'tmp/new.txt': '1' }, ['src'], 'kanban/todo/x.md').some((entry) => entry === 'UNKNOWN_FILE: tmp/new.txt'), 'unknown file classification'],
        [outsideScopeFindings({ 'tmp/old.txt': '1' }, {}, ['src'], 'kanban/todo/x.md').some((entry) => entry === 'MISSING_OUTSIDE_SCOPE_FILE: tmp/old.txt'), 'missing file classification'],
        [outsideScopeFindings({ 'tmp/changed.txt': '1' }, { 'tmp/changed.txt': '2' }, ['src'], 'kanban/todo/x.md').some((entry) => entry === 'CHANGED_OUTSIDE_SCOPE_FILE: tmp/changed.txt'), 'changed file classification'],
        [outsideScopeFindings({ 'MEMORY.md': '1' }, { 'MEMORY.md': '2' }, ['src'], 'kanban/todo/x.md', [], ['MEMORY.md']).length === 0, 'Executor-owned Memory drift is excluded from Worker scope findings'],
        [outsideScopeFindings({ '.runtime/process.pid': '1' }, {}, ['src'], 'kanban/todo/x.md').length === 0, 'ignored operational runtime files do not create scope drift'],
        [outsideScopeFindings({}, { 'tmp/kept.txt': '1' }, ['src'], 'kanban/todo/x.md', [{ path: 'tmp/kept.txt', hash: '1', reason: 'intentional retained output' }]).length === 0, 'matching task whitelist'],
        [outsideScopeFindings({}, { 'tmp/kept.txt': '2' }, ['src'], 'kanban/todo/x.md', [{ path: 'tmp/kept.txt', hash: '1', reason: 'intentional retained output' }]).some((entry) => entry === 'WHITELISTED_FILE_CHANGED: tmp/kept.txt'), 'whitelist hash enforcement'],
        [relevantChangedPaths({ 'data.db-wal': '1', 'src/a.ts': '1' }, { 'data.db-wal': '2', 'src/a.ts': '2' }).join(',') === 'src/a.ts', 'runtime changes are ignored'],
        [relevantChangedPaths({ 'data.db': '1', 'src/a.ts': '1' }, { 'data.db': '2', 'src/a.ts': '2' }).join(',') === 'src/a.ts', 'database files are ignored'],
        [relevantChangedPaths({ '.opencode/plugin.ts': '1', 'src/a.ts': '1' }, { '.opencode/plugin.ts': '2', 'src/a.ts': '2' }).join(',') === 'src/a.ts', 'workflow administration changes are ignored'],
        [authorizedRuleTransition('CUSTOM.md', 'a', 'b', [{ path: 'CUSTOM.md', beforeHash: 'a', afterHash: 'b', violationID: '123456789abc' }]), 'authorized CUSTOM transition'],
        [authorizedRuleTransition('CUSTOM.md', 'a', 'c', [
            { path: 'CUSTOM.md', beforeHash: 'a', afterHash: 'b', violationID: '123456789abc' },
            { path: 'CUSTOM.md', beforeHash: 'b', afterHash: 'c', violationID: 'abcdef123456' },
        ]), 'chained authorized CUSTOM transition'],
        [!authorizedRuleTransition('CUSTOM.md', 'a', 'c', [{ path: 'CUSTOM.md', beforeHash: 'a', afterHash: 'b', violationID: '123456789abc' }]), 'unauthorized CUSTOM transition'],
        [relevantChangedPaths({ 'CUSTOM.md': 'a' }, { 'CUSTOM.md': 'b' }, [{ beforeHash: 'a', afterHash: 'b', violationID: '123456789abc' }]).length === 0, 'authorized CUSTOM change is ignored'],
        [relevantChangedPaths({ 'CUSTOM.md': 'a' }, { 'CUSTOM.md': 'c' }, [{ beforeHash: 'a', afterHash: 'b', violationID: '123456789abc' }]).join(',') === 'CUSTOM.md', 'unreceipted CUSTOM change is retained'],
        [relevantChangedPaths({ 'WORKER.md': 'a' }, { 'WORKER.md': 'b' }, [{ path: 'WORKER.md', beforeHash: 'a', afterHash: 'b', violationID: 'abcdef123456' }]).length === 0, 'authorized WORKER change is ignored'],
        [relevantChangedPaths({ 'MEMORY.md': 'a' }, { 'MEMORY.md': 'b' }, [{ path: 'MEMORY.md', beforeHash: 'a', afterHash: 'b', recoveryID: 'M1' }]).length === 0, 'authorized MEMORY change is ignored'],
        [relevantChangedPaths({ 'AGENTS.md': 'a' }, { 'AGENTS.md': 'b' }, [{ path: 'AGENTS.md', beforeHash: 'a', afterHash: 'b', recoveryID: 'H1' }]).length === 0, 'authorized Harness change is ignored'],
        [recoveryPatternMatches('WORKER-GEMMA4.md', 'WORKER-*.md'), 'Harness wildcard path matching'],
        [matchesExecutorRecoveryPath('AGENTS.md'), 'default Harness rule paths use Executor recovery'],
        [recoveryPatternMatches('scripts/task-doctor.mjs', 'scripts'), 'Harness directory path matching'],
        [taskRelevantChangedPaths({ 'MEMORY.md': 'a', 'src/a.ts': 'a' }, { 'MEMORY.md': 'b', 'src/a.ts': 'b' }, { memoryAction: 'none' }).join(',') === 'src/a.ts', 'unrelated MEMORY change is excluded from Worker files'],
        [schedulingConflict({ allowedScope: ['src/a'], scheduling: { resources: [] } }, { allowedScope: ['src/a/b'], scheduling: { resources: [] } }), 'scheduling scope conflict'],
        [schedulingConflict({ allowedScope: ['src/a'], scheduling: { resources: ['database'] } }, { allowedScope: ['src/b'], scheduling: { resources: ['database'] } }), 'scheduling resource conflict'],
        [!schedulingConflict({ allowedScope: ['src/a'], scheduling: { resources: [] } }, { allowedScope: ['src/b'], scheduling: { resources: [] } }), 'disjoint scheduling'],
        [forbiddenCommand.test('npm test | head -5'), 'filtered command rejection'],
        [forbiddenCommand.test('git commit -m test'), 'Git command rejection'],
        [!forbiddenCommand.test('npm run build && npm test'), 'safe command acceptance'],
        [verifyCommandFormatError('npm test') === null, 'executable Verify command acceptance'],
        [Boolean(verifyCommandFormatError('npm test (ensure no regressions)')), 'Verify shell syntax rejection'],
        [verifyNpmScriptErrors('npm --prefix . run task:doctor:test').length === 0, 'existing prefixed npm Verify script acceptance'],
        [verifyNpmScriptErrors('npm --prefix . run definitely-missing').some((error) => error.startsWith('VERIFY_SCRIPT_MISSING:')), 'missing prefixed npm Verify script rejection'],
        [verifyNpmScriptErrors('npm run task:doctor:test -- --example').length === 0, 'existing npm Verify script with arguments acceptance'],
        [verifyNpmScriptErrors('npm run task:doctor:test && npm run task:doctor:lint').length === 0, 'multiple existing npm Verify scripts acceptance'],
        [verifyNpmScriptErrors('npm --prefix ../../outside run test').some((error) => error.startsWith('VERIFY_PACKAGE_OUTSIDE_PROJECT:')), 'outside-project npm prefix rejection'],
        [parseVerifyCommands('- `npm test` (expect exit 2)')[0]?.command === 'npm test', 'Verify command parsing'],
        [parseVerifyCommands('- `npm test` (expect exit 2)')[0]?.expectedExit === 2, 'Verify expected exit parsing'],
        [matchesFilesystemIgnore('node_modules/a.js'), 'filesystem directory ignore'],
        [withPackageCompanions(['package.json']).includes('package-lock.json'), 'package lock companion scope'],
        [matchesFilesystemIgnore('src/a.log'), 'filesystem extension ignore'],
        [['none', 'append', 'update', 'remove'].every((action) => /^(none|append|update|remove)$/.test(action)), 'memory actions'],
        [executableTestPattern.test('npm run test:unit'), 'test command detection'],
        [parseScopeEntries('\n- src/a.ts\n\nBefore reading:\n- npm test').length === 1, 'scope parser stops after declaration list'],
        [parseContextEntries('\n- src/a.ts\n- `src/b.ts`\n').paths.join(',') === 'src/a.ts,src/b.ts', 'Context path parsing'],
        [parseContextEntries('\nREAD: src/a.ts\n').invalidLines.length === 1, 'Context prose rejection'],
        [contextPathError('scripts/task-doctor.mjs') === null, 'existing regular Context file acceptance'],
        [contextPathError('scripts') === 'path must be a regular file', 'Context directory rejection'],
        [contextPathError('missing-context-file') === 'path does not exist', 'missing Context path rejection'],
        [scopePathFormatError('src/a.ts') === null, 'exact scope path acceptance'],
        [scopePathFormatError('src/public exports/index.ts') === null, 'scope path with spaces acceptance'],
        [Boolean(scopePathFormatError('../outside.ts')), 'parent scope path rejection'],
        [Boolean(scopePathFormatError('src/**/*.tsx')), 'wildcard scope path rejection'],
        [hasTechnicalOperationEvidence({ changedFiles: ['src/a.ts'], commands: [] }), 'changed path technical evidence'],
        [hasTechnicalOperationEvidence({ changedFiles: [], commands: [{ expectedExit: 0, actualExit: 0 }] }), 'successful Verify technical evidence'],
        [!hasTechnicalOperationEvidence({ changedFiles: [], commands: [] }), 'empty technical evidence rejection'],
        [normalizeTaskDependency('04-prerequisite.md') === '04-prerequisite.md', 'dependency filename normalization'],
        [normalizeTaskDependency('kanban/todo/04-prerequisite.md') === '04-prerequisite.md', 'todo dependency path normalization'],
        [normalizeTaskDependency('kanban/done/04-prerequisite.md') === '04-prerequisite.md', 'done dependency path normalization'],
        [normalizeTaskDependency('04-prerequisite', new Set(['kanban/todo/04-prerequisite.md'])) === '04-prerequisite.md', 'unique dependency suffix repair'],
        [normalizeTaskDependency('kanban/done/04-prerequisite', new Set(['kanban/done/04-prerequisite.md'])) === '04-prerequisite.md', 'exact dependency path suffix repair'],
        [normalizeTaskDependency('04-prerequisite', new Set()) === null, 'missing dependency suffix repair rejection'],
        [normalizeTaskDependency('04-prerequisite', new Set(['kanban/todo/04-prerequisite.md', 'kanban/done/04-prerequisite.md'])) === null, 'ambiguous dependency suffix repair rejection'],
        [normalizeTaskDependenciesInContent('Depends on: 04-prerequisite\n', new Set(['kanban/todo/04-prerequisite.md'])).content === 'Depends on: 04-prerequisite.md\n', 'dependency suffix content repair'],
        [normalizeTaskDependency('other/04-prerequisite.md') === null, 'invalid dependency path rejection'],
        [parseByteSize('15kb') === 15 * 1024, 'kilobyte config parsing'],
        [parseByteSize('1.5mb') === 1.5 * 1024 * 1024, 'megabyte config parsing'],
        [parseByteSize('wat') === null, 'invalid size rejection'],
        [changedVerifyState([{ type: 'sqlite', path: 'a.db', hash: '1' }], [{ type: 'sqlite', path: 'a.db', hash: '2' }]).length === 1, 'persistent state change detection'],
    ];
    const failed = assertions.filter(([passed]) => !passed).map(([, name]) => name);
    if (failed.length) fail(failed.map((name) => `SELF_TEST: ${name}`));
    console.log(`TASK DOCTOR: SELF TEST PASS (${assertions.length} checks)`);
}

const [command, taskPath, filePath, ...reasonParts] = process.argv.slice(2);
if (command === 'next') nextTask();
else if (command === 'schedule') printSchedule();
else if (command === 'self-test') selfTest();
else if (command === 'lint' && taskPath) lint(taskPath);
else if (command === 'register' && taskPath) register(taskPath);
else if (command === 'start' && taskPath) start(taskPath);
else if (command === 'verify' && taskPath) verify(taskPath);
else if (command === 'complete' && taskPath) complete(taskPath);
else if (command === 'whitelist' && taskPath && filePath) whitelistFile(taskPath, filePath, reasonParts);
else if (command === 'test-file' && taskPath && filePath) registerTestFile(taskPath, filePath);
else {
    console.log('Usage: node scripts/task-doctor.mjs <next|schedule|self-test|lint|register|start|verify|complete|whitelist|test-file> [kanban/todo/<task>.md] [path] [reason]');
    process.exit(command ? 1 : 0);
}
