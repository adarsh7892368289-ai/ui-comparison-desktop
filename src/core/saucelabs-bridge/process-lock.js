'use strict';

// Cross-instance lock files for SauceLabs tmp dirs.
//
// Each in-flight job writes a small JSON lock file at the root of its tmp
// dir containing { pid, startedAt }. cleanupOrphanedTmpDirs() reads the lock
// before deleting; if the PID is still alive AND it's not us, we leave the
// dir alone. This keeps two app instances from racing each other's state
// during simultaneous startup.
//
// Pure helpers — accept fs/process injection for testability. The default
// closure uses the real `fs` and `process`.

const fsDefault = require('fs');
const path = require('path');

const LOCK_FILE_NAME = '.sauce-job.lock';

function _isProcessAliveDefault(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    // kill(pid, 0) checks existence without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but unsignalable (still alive).
    return err.code === 'EPERM';
  }
}

function writeLockFile(dir, opts = {}) {
  const fs = opts.fs ?? fsDefault;
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ pid, startedAt: now() });
    fs.writeFileSync(path.join(dir, LOCK_FILE_NAME), payload);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(dir, opts = {}) {
  const fs = opts.fs ?? fsDefault;
  try {
    const raw = fs.readFileSync(path.join(dir, LOCK_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid === 'number' && typeof parsed?.startedAt === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function removeLockFile(dir, opts = {}) {
  const fs = opts.fs ?? fsDefault;
  try {
    fs.unlinkSync(path.join(dir, LOCK_FILE_NAME));
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid, opts = {}) {
  const checker = opts.isProcessAlive ?? _isProcessAliveDefault;
  return checker(pid);
}

// Decision rule for cleanup. Returns true if the dir is safe to delete.
//   - If the lock points to a live PID that isn't us, NOT safe.
//   - If the lock points to a dead PID OR our own PID (previous run), safe.
//   - If no lock and dir mtime is older than staleThresholdMs, safe.
//   - If no lock and dir is recent, NOT safe (might be mid-write by another instance).
function isStaleTmpDir(dir, opts = {}) {
  const fs = opts.fs ?? fsDefault;
  const ourPid = opts.ourPid ?? process.pid;
  const staleThresholdMs = opts.staleThresholdMs ?? (6 * 60 * 60 * 1000);
  const now = opts.now ?? Date.now;
  const isAlive = opts.isProcessAlive ?? _isProcessAliveDefault;

  const lock = readLockFile(dir, { fs });
  if (lock) {
    if (lock.pid === ourPid) return { stale: true, reason: 'own-prior-run' };
    if (isAlive(lock.pid)) return { stale: false, reason: 'live-other-instance', pid: lock.pid };
    return { stale: true, reason: 'dead-pid', pid: lock.pid };
  }

  let stat;
  try { stat = fs.statSync(dir); } catch { return { stale: false, reason: 'stat-failed' }; }
  const ageMs = now() - stat.mtimeMs;
  if (ageMs >= staleThresholdMs) return { stale: true, reason: 'mtime-aged', ageMs };
  return { stale: false, reason: 'recent-no-lock', ageMs };
}

module.exports = {
  LOCK_FILE_NAME,
  writeLockFile,
  readLockFile,
  removeLockFile,
  isProcessAlive,
  isStaleTmpDir
};
