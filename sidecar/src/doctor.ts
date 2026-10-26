/**
 * AnythingPocket sidecar — `anythingpocket doctor` (M1: installer + doctor).
 * Checks: node version, DB writable, port available. Human-readable output,
 * bilingual EN+ID. Exit 0 = healthy, 1 = unhealthy.
 */
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { DB_PATH, DATA_DIR } from './db.ts';
import { createRequire } from 'node:module';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string; // human sentence, EN + ID
}

function checkNode(): DoctorCheck {
  const [maj] = process.versions.node.split('.').map(Number);
  const ok = maj >= 22; // node:sqlite needs >=22.5
  return {
    name: 'Node.js',
    ok,
    detail: ok
      ? `Node ${process.versions.node} OK (butuh >= 22.5)`
      : `Node ${process.versions.node} terlalu lama / too old — butuh / need >= 22.5 (node:sqlite)`,
  };
}

function checkDbWritable(): DoctorCheck {
  const probe = resolve(DATA_DIR, '.doctor-probe');
  try {
    closeSync(openSync(probe, 'w'));
    unlinkSync(probe);
    return {
      name: 'Database',
      ok: true,
      detail: `Direktori data bisa ditulis / data dir writable: ${DATA_DIR}`,
    };
  } catch (e) {
    return {
      name: 'Database',
      ok: false,
      detail: `Tidak bisa menulis / cannot write: ${DATA_DIR} — ${String(e)}`,
    };
  }
}

function checkDeps(): DoctorCheck {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('ws');
    req('node:sqlite'); // throws if node:sqlite unavailable
    return {
      name: 'Dependencies',
      ok: true,
      detail: 'Modul runtime tersedia / runtime modules available (ws, node:sqlite)',
    };
  } catch (e) {
    return {
      name: 'Dependencies',
      ok: false,
      detail: `Dependency runtime hilang / missing — jalankan / run: npm ci --omit=dev (${String(e)})`,
    };
  }
}

function checkPort(port: number, bind: string): Promise<DoctorCheck> {
  return new Promise((res) => {
    const s = createConnection({ port, host: bind });
    s.once('connect', () => { s.destroy(); res({ name: 'Port', ok: false, detail: `Port ${port} sudah dipakai / already in use` }); });
    s.once('error', () => res({ name: 'Port', ok: true, detail: `Port ${port} bebas / free` }));
  });
}

export async function runDoctor(port = 7443, bind = '127.0.0.1'): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [checkNode(), checkDeps(), checkDbWritable(), await checkPort(port, bind)];
  return { ok: checks.every((c) => c.ok), checks };
}

export async function doctorMain(port = Number(process.env.PORT ?? 7443), bind = process.env.BIND ?? '127.0.0.1'): Promise<number> {
  const { ok, checks } = await runDoctor(port, bind);
  console.log('AnythingPocket doctor');
  console.log('=====================');
  for (const c of checks) {
    console.log(`[${c.ok ? 'OK' : 'GAGAL/FAIL'}] ${c.name}: ${c.detail}`);
  }
  console.log(ok
    ? 'Semua sehat — jalankan server / all healthy — start the server.'
    : 'Ada masalah di atas / fix the problems above first.');
  return ok ? 0 : 1;
}

// DB_PATH imported so a change of location updates doctor too (single source).
void DB_PATH;
