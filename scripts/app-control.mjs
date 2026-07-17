#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = resolve(root, '.runtime');
const projectConfigPath = resolve(root, 'project.json');

function readRuntimeSettings() {
    let projectConfig;
    try {
        projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read project.json: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }

    const runtime = projectConfig?.settings?.appRuntime;
    const backendPort = runtime?.backendPort;
    const frontendPort = runtime?.frontendPort;
    for (const [name, port] of Object.entries({ backendPort, frontendPort })) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`project.json settings.appRuntime.${name} must be an integer from 1 to 65535`);
        }
    }
    if (backendPort === frontendPort) throw new Error('Backend and frontend ports must differ');
    return { backendPort, frontendPort };
}

const { backendPort, frontendPort } = readRuntimeSettings();
const backendUrl = `http://localhost:${backendPort}`;
const frontendUrl = `http://localhost:${frontendPort}`;
const services = [
    {
        name: 'backend',
        workspace: 'code/backend',
        port: backendPort,
        processPattern: /(?:nodemon|ts-node).*src\/index\.ts/,
        args: ['--prefix', 'code/backend', 'run', 'dev'],
        env: { PORT: String(backendPort), APP_URL: frontendUrl },
    },
    {
        name: 'frontend',
        workspace: 'code/frontend',
        port: frontendPort,
        processPattern: /(?:node[^\n]*\/vite|vite(?:\.js)?)(?:\s|$)/,
        args: ['--prefix', 'code/frontend', 'run', 'dev', '--', '--port', String(frontendPort)],
        env: { VITE_PROXY_TARGET: backendUrl },
    },
];

function pidPath(service) {
    return resolve(runtimeDirectory, `${service.name}.pid`);
}

function logPath(service) {
    return resolve(runtimeDirectory, `${service.name}.log`);
}

function trackedPid(service) {
    try {
        const pid = Number(readFileSync(pidPath(service), 'utf8').trim());
        return Number.isInteger(pid) && pid > 1 ? pid : null;
    } catch {
        return null;
    }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function processRows() {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    return result.stdout.split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
    });
}

function servicePids(service) {
    const workspace = resolve(root, service.workspace);
    const matches = processRows()
        .filter(({ command }) => command.includes(workspace) && service.processPattern.test(command))
        .map(({ pid }) => pid);
    const tracked = trackedPid(service);
    return [...new Set([tracked, ...matches].filter((pid) => pid && isAlive(pid)))];
}

function portOwnerPids(port) {
    const result = spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`Cannot inspect port ${port}: ${result.stderr.trim() || 'lsof failed'}`);
    }
    return [...new Set(result.stdout
        .split(/\r?\n/)
        .map((value) => Number(value.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid))];
}

function portOpen(port) {
    return new Promise((resolveResult) => {
        const socket = createConnection({ host: 'localhost', port });
        const finish = (open) => {
            socket.destroy();
            resolveResult(open);
        };
        socket.setTimeout(400);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function waitForPort(port, expectedOpen, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await portOpen(port) === expectedOpen) return true;
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    } while (Date.now() < deadline);
    return false;
}

async function status() {
    let running = 0;
    for (const service of services) {
        const pids = servicePids(service);
        const listening = await portOpen(service.port);
        if (pids.length > 0 || listening) running += 1;
        const state = pids.length > 0 ? listening ? 'ready' : 'starting' : listening ? 'occupied' : 'stopped';
        console.log(`${service.name}: ${state}; port ${service.port}; pids ${pids.join(', ') || 'none'}`);
    }
    return running;
}

async function startService(service) {
    const pids = servicePids(service);
    const listening = await portOpen(service.port);
    if (pids.length > 0) {
        console.log(`${service.name}: already running`);
        return;
    }
    if (listening) throw new Error(`${service.name} port ${service.port} is occupied by another process`);

    mkdirSync(runtimeDirectory, { recursive: true });
    const log = openSync(logPath(service), 'a');
    const child = spawn('npm', service.args, {
        cwd: root,
        detached: true,
        env: { ...process.env, ...service.env, NO_COLOR: '1' },
        stdio: ['ignore', log, log],
    });
    child.unref();
    closeSync(log);
    writeFileSync(pidPath(service), `${child.pid}\n`);

    if (!await waitForPort(service.port, true)) {
        await stopService(service);
        throw new Error(`${service.name} did not open port ${service.port}; inspect ${logPath(service)}`);
    }
    console.log(`${service.name}: started on port ${service.port}`);
}

async function start() {
    for (const service of services) await startService(service);
    console.log(`App ready: ${frontendUrl}`);
}

async function stopService(service) {
    const pids = servicePids(service);
    if (pids.length === 0 && !await portOpen(service.port)) {
        rmSync(pidPath(service), { force: true });
        console.log(`${service.name}: already stopped`);
        return;
    }

    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {}
    }
    await waitForPort(service.port, false, 5_000);
    for (const pid of pids.filter(isAlive)) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {}
    }
    rmSync(pidPath(service), { force: true });
    if (await portOpen(service.port)) throw new Error(`${service.name} still owns port ${service.port}`);
    console.log(`${service.name}: stopped`);
}

async function stop() {
    for (const service of [...services].reverse()) await stopService(service);
}

async function clearServicePort(service) {
    const gracefulPids = [...new Set([...servicePids(service), ...portOwnerPids(service.port)])];
    for (const pid of gracefulPids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {}
    }

    if (!await waitForPort(service.port, false, 5_000)) {
        const forcePids = [...new Set([...servicePids(service), ...portOwnerPids(service.port)])];
        for (const pid of forcePids) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {}
        }
        await waitForPort(service.port, false, 2_000);
    }

    rmSync(pidPath(service), { force: true });
    if (await portOpen(service.port)) throw new Error(`${service.name} port ${service.port} is still occupied`);
    console.log(`${service.name}: port ${service.port} is free`);
}

async function clearPorts() {
    for (const service of [...services].reverse()) await clearServicePort(service);
}

const command = process.argv[2];
if (command === 'status') await status();
else if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'clear-ports') await clearPorts();
else if (command === 'restart') {
    await stop();
    await start();
} else {
    console.error('Usage: node scripts/app-control.mjs <status|start|stop|restart|clear-ports>');
    process.exitCode = 1;
}
