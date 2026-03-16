/**
 * Language Model Tools — exposes JStall functionality to AI assistants
 * (GitHub Copilot, etc.) via VS Code's Language Model Tools API.
 *
 * Uses a lightweight registerTool helper (inspired by the Slidev VS Code
 * extension) that removes per-tool class boilerplate: each tool is just an
 * async function `(input, token) => string`.
 *
 * Tools:
 *  - jstall_list_jvms  — convenience: list running JVMs with active marker
 *  - jstall_run        — generic: run any jstall command with arbitrary args
 *  - jstall_status     — typed: JVM status diagnostics with all parameters
 *  - jstall_flamegraph — special: captures flamegraph HTML and returns path
 *  - jstall_record     — special: records diagnostics ZIP and returns path
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { runJstall, stripAnsi, resolveRecordingSavePath } from './jstall';
import { listJvms } from './jvmPicker';
import { getActiveJvm } from './debugIntegration';

// ─── helpers ──────────────────────────────────────────────────────

type PidSelector = number | 'all';

function resolveTarget(input: { pid?: number | string }): PidSelector | undefined {
    if (input.pid === 'all') {
        return 'all';
    }
    if (typeof input.pid === 'number') {
        return input.pid;
    }
    if (typeof input.pid === 'string') {
        const maybePid = Number.parseInt(input.pid, 10);
        if (Number.isInteger(maybePid) && maybePid > 0) {
            return maybePid;
        }
    }
    return getActiveJvm()?.pid;
}

function requireNumericPid(input: { pid?: number | string }): number {
    const target = resolveTarget(input);
    if (target === 'all') {
        throw new Error('"all" is not supported for this command. Please provide a specific PID.');
    }
    if (!target) {
        throw new Error(
            'No PID specified and no active JVM detected. ' +
            'Use jstall_list_jvms to find running JVMs first.'
        );
    }
    return target;
}

function requireStatusOrRecordTarget(input: { pid?: number | string }): PidSelector {
    const target = resolveTarget(input);
    if (target !== undefined) {
        return target;
    }
    throw new Error(
        'No PID specified and no active JVM detected. ' +
        'Use jstall_list_jvms to find running JVMs first, or set pid to "all".'
    );
}

function jstallOutput(result: { stdout: string; stderr: string; exitCode: number }): string {
    const output = stripAnsi(
        result.stdout + (result.stderr ? '\n' + result.stderr : '')
    ).trim();
    return output || `Command exited with code ${result.exitCode} and produced no output.`;
}

interface McpStatusDefaults {
    full: boolean;
    intelligentFilter: boolean;
    noNative: boolean;
    keep: boolean;
    top: number;
    dumps?: number;
    interval?: string;
}

interface McpFlamegraphDefaults {
    durationSeconds: number;
    event: string;
    interval: string;
}

interface McpRecordDefaults {
    full: boolean;
    count: number;
    interval: string;
}

function getMcpStatusDefaults(): McpStatusDefaults {
    const config = vscode.workspace.getConfiguration('jstall');
    return {
        full: config.get<boolean>('mcp.status.full', config.get<boolean>('fullDiagnostics', false)),
        intelligentFilter: config.get<boolean>('mcp.status.intelligentFilter', config.get<boolean>('intelligentFilter', false)),
        noNative: config.get<boolean>('mcp.status.noNative', config.get<boolean>('noNative', false)),
        keep: config.get<boolean>('mcp.status.keep', config.get<boolean>('keep', false)),
        top: config.get<number>('mcp.status.top', config.get<number>('top', 3)),
        dumps: config.get<number | null>('mcp.status.dumps', null) ?? undefined,
        interval: config.get<string>('mcp.status.interval', '').trim() || undefined,
    };
}

function getMcpFlamegraphDefaults(): McpFlamegraphDefaults {
    const config = vscode.workspace.getConfiguration('jstall');
    return {
        durationSeconds: config.get<number>('mcp.flamegraph.durationSeconds', config.get<number>('flameDurationSeconds', 10)),
        event: config.get<string>('mcp.flamegraph.event', 'cpu').trim() || 'cpu',
        interval: config.get<string>('mcp.flamegraph.interval', '10ms').trim() || '10ms',
    };
}

function getMcpRecordDefaults(): McpRecordDefaults {
    const config = vscode.workspace.getConfiguration('jstall');
    const intervalSeconds = config.get<number>('recordIntervalSeconds', 5);
    return {
        full: config.get<boolean>('mcp.record.full', config.get<boolean>('fullDiagnostics', false)),
        count: config.get<number>('mcp.record.count', 2),
        interval: config.get<string>('mcp.record.interval', `${intervalSeconds}s`).trim() || `${intervalSeconds}s`,
    };
}

/**
 * Registers a language-model tool with centralised error handling.
 * Each tool is just an async function that returns a plain string —
 * the helper wraps it in a LanguageModelToolResult and catches errors.
 */
function registerTool<T>(
    context: vscode.ExtensionContext,
    name: string,
    invoke: (input: T, token: vscode.CancellationToken) => string | Promise<string>,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool<T>(name, {
            async invoke(options, token) {
                try {
                    const text = await invoke(options.input, token);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(text),
                    ]);
                } catch (error: unknown) {
                    const msg = error instanceof Error ? error.message : String(error);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error: ${msg}`),
                    ]);
                }
            },
        }),
    );
}

// ─── Registration ─────────────────────────────────────────────────

export function registerMcpTools(context: vscode.ExtensionContext): void {
    if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
        console.log('JStall: Language Model Tools API not available, skipping tool registration.');
        return;
    }

    // ── List JVMs ─────────────────────────────────────────────────
    registerTool<Record<string, never>>(context, 'jstall_list_jvms', async () => {
        const jvms = await listJvms(context);
        if (jvms.length === 0) {
            return 'No JVM processes found.';
        }
        const activeJvm = getActiveJvm();
        return jvms
            .map(jvm => {
                const marker = activeJvm?.pid === jvm.pid ? ' (active)' : '';
                return `PID ${jvm.pid}: ${jvm.name}${marker}`;
            })
            .join('\n');
    });

    // ── Run (generic) ─────────────────────────────────────────────
    registerTool<{ args: string[] }>(context, 'jstall_run', async (input, token) => {
        const args = input.args ?? [];
        if (args.length === 0) {
            throw new Error('No arguments provided. Try ["--help"] to see available commands.');
        }
        return jstallOutput(await runJstall(context, args, token));
    });

    // ── Status ────────────────────────────────────────────────────
    registerTool<{
        pid?: number | 'all';
        recordingZip?: string;
        full?: boolean;
        intelligentFilter?: boolean;
        noNative?: boolean;
        keep?: boolean;
        top?: number;
        dumps?: number;
        interval?: string;
    }>(context, 'jstall_status', async (input, token) => {
        const defaults = getMcpStatusDefaults();
        const statusArgs: string[] = [];

        // Toggle boolean flags
        const boolFlags: [string, boolean | undefined][] = [
            ['--full', input.full ?? defaults.full],
            ['--intelligent-filter', input.intelligentFilter ?? defaults.intelligentFilter],
            ['--no-native', input.noNative ?? defaults.noNative],
            ['--keep', input.keep ?? defaults.keep],
        ];
        for (const [flag, val] of boolFlags) {
            if (val) { statusArgs.push(flag); }
        }

        const top = input.top ?? defaults.top;
        if (top !== 3) {
            statusArgs.push(`--top=${top}`);
        }
        const dumps = input.dumps ?? defaults.dumps;
        if (dumps !== undefined) {
            statusArgs.push(`--dumps=${dumps}`);
        }
        const interval = input.interval ?? defaults.interval;
        if (interval) {
            statusArgs.push(`--interval=${interval}`);
        }

        const args: string[] = ['status', ...statusArgs];

        if (input.recordingZip) {
            args.push(input.recordingZip);
        } else {
            args.push(String(requireStatusOrRecordTarget(input)));
        }

        return jstallOutput(await runJstall(context, args, token));
    });

    // ── Flamegraph ────────────────────────────────────────────────
    registerTool<{
        pid?: number;
        durationSeconds?: number;
        event?: string;
        interval?: string;
        recordingZip?: string;
    }>(context, 'jstall_flamegraph', async (input, token) => {
        const tmpFile = path.join(os.tmpdir(), `jstall-flame-${Date.now()}.html`);
        const defaults = getMcpFlamegraphDefaults();

        if (input.recordingZip) {
            const args = ['-f', input.recordingZip, 'flame'];
            if (input.pid) { args.push(String(input.pid)); }
            args.push('-o', tmpFile);
            const result = await runJstall(context, args, token);

            if (result.exitCode === 0 && fs.existsSync(tmpFile)) {
                return `Flamegraph from recording saved to ${tmpFile}. Open it in a browser.`;
            }
            throw new Error(`Flamegraph from recording failed: ${stripAnsi(result.stderr || result.stdout)}`);
        }

        const pid = requireNumericPid(input);
        const flameArgs: string[] = [];

        const durationSeconds = input.durationSeconds ?? defaults.durationSeconds;
        if (durationSeconds !== 10) {
            flameArgs.push(`--duration=${durationSeconds}s`);
        }
        const event = input.event ?? defaults.event;
        if (event !== 'cpu') {
            flameArgs.push(`--event=${event}`);
        }
        const interval = input.interval ?? defaults.interval;
        if (interval !== '10ms') {
            flameArgs.push(`--interval=${interval}`);
        }

        const args = ['flame', ...flameArgs, '-o', tmpFile, String(pid)];
        const result = await runJstall(context, args, token);

        if (result.exitCode === 0 && fs.existsSync(tmpFile)) {
            return `Flamegraph captured for PID ${pid} and saved to ${tmpFile}. ` +
                'Open it in a browser for an interactive CPU profiling flamegraph.';
        }

        throw new Error(`Flamegraph capture failed: ${stripAnsi(result.stderr || result.stdout)}`);
    });

    // ── Record ────────────────────────────────────────────────────
    registerTool<{
        pid?: number | 'all';
        full?: boolean;
        count?: number;
        interval?: string;
    }>(context, 'jstall_record', async (input, token) => {
        const target = requireStatusOrRecordTarget(input);
        const { savePath } = resolveRecordingSavePath(target);
        const defaults = getMcpRecordDefaults();

        const recordArgs: string[] = [];
        const full = input.full ?? defaults.full;
        if (full) {
            recordArgs.push('--full');
        }
        const count = input.count ?? defaults.count;
        if (count !== 2) {
            recordArgs.push(`--count=${count}`);
        }
        const interval = input.interval ?? defaults.interval;
        if (interval !== '5s') {
            recordArgs.push(`--interval=${interval}`);
        }

        const args = ['record', 'create', ...recordArgs, '-o', savePath, String(target)];
        const result = await runJstall(context, args, token);

        if (result.exitCode === 0) {
            return `Recording saved to ${savePath}. Use jstall_run with ` +
                `["status", "${savePath}"] to analyze it, or ` +
                `jstall_flamegraph with recordingZip to view its flamegraph.`;
        }

        throw new Error(`Recording failed: ${stripAnsi(result.stderr || result.stdout)}`);
    });

    console.log('JStall: Registered 5 language model tools.');
}
