/**
 * M00's single-instance guard for `till up`: an advisory lock file holding the live instance's pid,
 * bound URL and start time.
 *
 * WHY A FILE AND WHY ADVISORY. Two `till up` processes on one machine would bind the same default
 * port (the second fails) OR, worse, run two schedulers against one database file, and two ticks
 * firing `run_due_automations` on one file is the double-write this guard exists to prevent (each
 * occurrence is idempotent, but a second writer pushes the D12 WAL past its two-writer ceiling). The
 * lock lets the second `till up` DETECT the first, print its URL and open the browser at it instead
 * of starting a rival process. It is machine state (D42), scoped to `TILL_SUPPORT_DIR`, and never
 * goes in the tenant database: a daemon lease inside the ledger would ride a G04 backup to another
 * machine and lie there.
 *
 * WHY ADVISORY IS HONEST HERE. There is a TOCTOU window between reading the lock and writing ours,
 * but the port bind is the real mutual-exclusion primitive underneath: if two processes race past
 * the lock, the second still fails to bind the port and exits. The lock's job is the friendly
 * redirect, not kernel-grade exclusion, and it says so.
 *
 * A STALE LOCK IS RECLAIMED. A process that dies without releasing leaves its lock behind; the next
 * start checks whether that pid is still alive and, if not, takes the lock over. A crash must not
 * wedge the machine out of ever starting again.
 */

import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/** What the lock records about the live instance. */
export interface UpLock {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
}

/** The lock's path inside the support directory. */
export function lockPath(supportDir: string): string {
  return join(supportDir, 'up.lock');
}

/**
 * Is a process with this pid still running? `kill(pid, 0)` sends no signal, it only probes: it
 * throws `ESRCH` when the pid is gone and `EPERM` when the pid exists but belongs to another user
 * (still alive, from our point of view). Any other error is treated as "cannot prove dead", so the
 * guard fails SAFE by leaving the lock in place rather than stealing it.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read and parse the lock, or null when it is missing or unreadable (a corrupt lock is no lock). */
export function readLock(supportDir: string): UpLock | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath(supportDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UpLock>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.url === 'string' &&
      typeof parsed.startedAt === 'string'
    ) {
      return parsed as UpLock;
    }
    return null;
  } catch {
    return null;
  }
}

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; holder: UpLock };

/**
 * Try to take the lock for our process. If a DIFFERENT, still-alive pid holds it, refuse and hand
 * back the holder so the caller can redirect the user to the running instance. A stale lock (dead
 * pid) or our own is overwritten.
 */
export function acquireLock(supportDir: string, lock: UpLock): AcquireResult {
  const existing = readLock(supportDir);
  if (existing !== null && existing.pid !== lock.pid && isProcessAlive(existing.pid)) {
    return { acquired: false, holder: existing };
  }
  mkdirSync(supportDir, { recursive: true });
  writeFileSync(lockPath(supportDir), JSON.stringify(lock, null, 2), 'utf8');
  return { acquired: true };
}

/**
 * Release the lock, but ONLY if it is still ours. A process must never delete a lock a newer instance
 * has since written (the reclaim path above may have handed the machine to someone else), so the pid
 * is checked before the unlink.
 */
export function releaseLock(supportDir: string, pid: number): void {
  const existing = readLock(supportDir);
  if (existing === null || existing.pid !== pid) return;
  try {
    unlinkSync(lockPath(supportDir));
  } catch {
    // A lock already gone is the state we wanted; nothing to do.
  }
}
