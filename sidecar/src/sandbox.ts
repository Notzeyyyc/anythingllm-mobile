/**
 * AnythingPocket sidecar — real bash sandbox (spec §6 release requirement).
 *
 * Detection chain: bwrap > docker > none. `none` is NOT a sandbox: per the
 * fail-toward-safety policy (differs from routing's fail-toward-capability)
 * an unavailable mechanism DISABLES the bash tool instead of running bash
 * unsandboxed. POCKET_SANDBOX=required turns unavailability into a hard error
 * and the turn fails.
 *
 * Mechanism: bwrap (bubblewrap, APT package on the HOST — not an npm dep):
 *   --unshare-net  : no network namespace at all → egress allowlist is
 *                    enforced by construction; the ONLY way out is the
 *                    secrets-proxy UNIX socket bind-mounted into the sandbox
 *                    (POCKET_PROXY_SOCKET) for provider/proxy access.
 *   --unshare-pid --die-with-parent --new-session : no host process view.
 *   --ro-bind / /  : read-only root; workspace re-bound RW on the same path.
 *   /etc/passwd + /etc/shadow masked with /dev/null (user enumeration blocked).
 *   --clearenv     : no host env leak; minimal PATH/HOME set explicitly.
 *
 * ponytail: docker builder intentionally minimal (only reached if docker is
 * installed, which it is not on this host); upgrade when someone actually
 * runs the docker route. Landlock is not attempted: kernel 5.15 has FS
 * Landlock but no network control, and a FS-only layer adds no containment
 * over bwrap here — documented in docs/m2a-full-runtime.md.
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import { OverlayFs } from 'just-bash';

export type SandboxMechanism = 'bwrap' | 'docker' | 'none';

export interface SandboxDecision {
  mechanism: SandboxMechanism;
  /** false = bash tool must be disabled (no real sandbox available). */
  bashEnabled: boolean;
  /** Human-readable warning when mechanism is 'none'. */
  warning?: string;
}

const BWRAP_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
const DOCKER_PATHS = ['/usr/bin/docker', '/usr/local/bin/docker'];

export function detectMechanism(): SandboxMechanism {
  if (BWRAP_PATHS.some((p) => existsSync(p))) return 'bwrap';
  if (DOCKER_PATHS.some((p) => existsSync(p))) return 'docker';
  return 'none';
}

/**
 * Resolve POCKET_SANDBOX (auto|bwrap|docker|required|none, default auto) into
 * a concrete decision. Throws ONLY for required-without-mechanism (turn must
 * fail loudly, spec §6 fail-toward-safety).
 */
export function resolveSandbox(envValue: string | undefined): SandboxDecision {
  const requested = (envValue ?? 'auto').toLowerCase();
  const available = detectMechanism();
  if (requested === 'none') {
    return {
      mechanism: 'none', bashEnabled: false,
      warning: 'POCKET_SANDBOX=none: sandbox dimatikan eksplisit — tool bash DISABLED (fail toward safety).',
    };
  }
  if (available === 'none') {
    if (requested === 'required') {
      throw new Error('POCKET_SANDBOX=required tetapi tidak ada mekanisme sandbox (bubblewrap/docker tidak ditemukan di host). Install bubblewrap (apt install bubblewrap) — bash tidak akan dijalankan tanpa sandbox.');
    }
    return {
      mechanism: 'none', bashEnabled: false,
      warning: 'Sandbox unavailable (bubblewrap/docker tidak ditemukan) — tool bash DISABLED (fail toward safety). Install: apt install bubblewrap.',
    };
  }
  // mechanism available
  if (requested === 'bwrap' && available !== 'bwrap') {
    throw new Error('POCKET_SANDBOX=bwrap tetapi bubblewrap tidak ditemukan di host (apt install bubblewrap).');
  }
  if (requested === 'docker' && available !== 'docker') {
    throw new Error('POCKET_SANDBOX=docker tetapi docker tidak ditemukan di host.');
  }
  return { mechanism: available, bashEnabled: true };
}

/** bwrap argv for one real bash inside the container (ro root, rw workspace). */
export function bwrapArgs(opts: {
  workspace: string;
  proxySocket?: string;
}): string[] {
  const args = [
    '--die-with-parent', '--new-session',
    '--unshare-net', '--unshare-pid', '--unshare-ipc',
    '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', opts.workspace,
    '--setenv', 'TERM', 'dumb',
    '--ro-bind', '/', '/',
    '--tmpfs', '/home',
    '--dir', '/home/user',
    '--bind', opts.workspace, opts.workspace,
    // HarnessAgent hardcodes per-session workdirs below /home/user.
    '--bind', opts.workspace, '/home/user',
    '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/run',
    // mask credential files: user enumeration / password hashes not readable
    '--ro-bind', '/dev/null', '/etc/passwd',
    '--ro-bind', '/dev/null', '/etc/shadow',
  ];
  // The single egress path: secrets proxy UNIX socket, bind-mounted read-only.
  if (opts.proxySocket) args.push('--ro-bind', opts.proxySocket, opts.proxySocket);
  return args;
}

/** Real bash argv: command runs via `bash -c` inside the container. */
function bashArgv(base: string[], command: string, env?: Record<string, string>): string[] {
  const envPrefix = env
    ? 'export ' + Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') + '; '
    : '';
  if (process.env.APO_SBX_DEBUG) console.error('bashArgv:', JSON.stringify([...base, '--', 'bash', '-c', `${envPrefix}${command}`]));
  return [...base, '--', 'bash', '-c', `${envPrefix}${command}`];
}

/**
 * Create a HarnessV1NetworkSandboxSession whose bash `run`/`spawn` executes
 * REAL processes inside bwrap (network namespace gone; only the proxy socket
 * reachable). File I/O delegates to the just-bash OverlayFs rooted at the
 * workspace (Pi file builtins stay in the in-memory overlay; real bash sees
 * the same directory on disk via the RW bind).
 *
 * ponytail: abortSignal is not wired into child kill yet (add on first
 * interrupt-during-bash bug); bwrap --die-with-parent bounds leaks anyway.
 */
export async function createSandboxSession(opts: {
  workspace: string;
  proxySocket?: string;
}): Promise<HarnessV1NetworkSandboxSession> {
  const workspace = resolvePath(opts.workspace);
  const base = bwrapArgs({ workspace, proxySocket: opts.proxySocket });
  // Inner session: file ops (OverlayFs) + NetworkSandboxSession infra surface.
  const inner = await createJustBashNetworkSandboxSession({
    fs: new OverlayFs({ root: workspace, mountPoint: '/' }),
  });
  const session = inner as unknown as Record<string, unknown> & HarnessV1NetworkSandboxSession;
  const overrides = {
    run: async ({ command, workingDirectory, env, abortSignal }: any) => {
    abortSignal?.throwIfAborted();
    // cwd is the HOST workspace path; workingDirectory is a SANDBOX path
    // (may not exist on host) → cd inside the container instead.
    const cd = workingDirectory ? `cd ${JSON.stringify(workingDirectory)} && ` : '';
    const child = spawn('bwrap', bashArgv(base, `${cd}${command}`, env), {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const exitCode: number = await new Promise((res, rej) => {
      child.once('error', rej);
      child.once('close', (code: number | null) => res(code ?? 1));
    });
    abortSignal?.throwIfAborted();
    return { exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
    },
    spawn: ({ command, workingDirectory, env }: any) => {
    const cd = workingDirectory ? `cd ${JSON.stringify(workingDirectory)} && ` : '';
    const child = spawn('bwrap', bashArgv(base, `${cd}${command}`, env), {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const enc = new TextEncoder();
    const mk = (stream: NodeJS.ReadableStream | null) => new ReadableStream({
      start(c) {
        stream?.on('data', (d: Buffer) => c.enqueue(enc.encode(d.toString('utf8'))));
        stream?.on('end', () => c.close());
        stream?.on('error', (e: unknown) => c.error(e));
      },
    });
    return {
      stdout: mk(child.stdout), stderr: mk(child.stderr),
      wait: () => new Promise<{ exitCode: number }>((res, rej) => {
        child.once('error', rej);
        child.once('close', (code: number | null) => res({ exitCode: code ?? 1 }));
      }),
      kill: async () => { child.kill('SIGKILL'); },
    };
    },
  };
  // readonly interface props → assign as a batch (runtime override is the point)
  Object.assign(session, overrides);
  return session;
}

/** One-shot self-check runnable directly: node --experimental-strip-types src/sandbox.ts */
if (process.argv[1]?.endsWith('sandbox.ts')) {
  const dec = resolveSandbox(process.env.POCKET_SANDBOX);
  console.log('decision:', JSON.stringify(dec));
  if (dec.mechanism === 'bwrap') {
    const s = await createSandboxSession({ workspace: '/tmp' });
    const r = await (s as any).run({ command: 'echo BWRAP_OK && curl -sS -m 3 http://1.1.1.1/ ; echo curl_exit=$?; cat /etc/passwd | wc -c' });
    console.log('run result:', JSON.stringify(r));
    await s.destroy();
  }
}
