import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LOCK_FILE_NAME,
  writeLockFile,
  readLockFile,
  removeLockFile,
  isStaleTmpDir
} from '@core/saucelabs-bridge/process-lock.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-lock-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});


describe('writeLockFile + readLockFile', () => {
  it('writes a JSON lock with our pid+startedAt and reads it back', () => {
    const before = Date.now();
    expect(writeLockFile(tmpDir)).toBe(true);

    const lock = readLockFile(tmpDir);
    expect(lock).not.toBeNull();
    expect(lock.pid).toBe(process.pid);
    expect(lock.startedAt).toBeGreaterThanOrEqual(before);
    expect(lock.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('writes the file at LOCK_FILE_NAME', () => {
    writeLockFile(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, LOCK_FILE_NAME))).toBe(true);
  });

  it('creates the directory if missing', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    expect(writeLockFile(nested)).toBe(true);
    expect(readLockFile(nested)).not.toBeNull();
  });

  it('returns null when no lock file exists', () => {
    expect(readLockFile(tmpDir)).toBeNull();
  });

  it('returns null when the lock file is malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, LOCK_FILE_NAME), 'not json');
    expect(readLockFile(tmpDir)).toBeNull();
  });

  it('returns null when the lock file has wrong shape', () => {
    fs.writeFileSync(path.join(tmpDir, LOCK_FILE_NAME), JSON.stringify({ pid: 'string', startedAt: 'string' }));
    expect(readLockFile(tmpDir)).toBeNull();
  });

  it('honors injected pid and now()', () => {
    writeLockFile(tmpDir, { pid: 99999, now: () => 12345 });
    expect(readLockFile(tmpDir)).toEqual({ pid: 99999, startedAt: 12345 });
  });
});

describe('removeLockFile', () => {
  it('removes the lock file and returns true', () => {
    writeLockFile(tmpDir);
    expect(removeLockFile(tmpDir)).toBe(true);
    expect(readLockFile(tmpDir)).toBeNull();
  });

  it('returns false silently when no lock file exists', () => {
    expect(removeLockFile(tmpDir)).toBe(false);
  });
});


describe('isStaleTmpDir', () => {
  it('returns NOT stale when the lock points to a live other-instance PID', () => {
    writeLockFile(tmpDir, { pid: 11111 });
    const decision = isStaleTmpDir(tmpDir, {
      ourPid: 22222,
      isProcessAlive: (pid) => pid === 11111
    });
    expect(decision.stale).toBe(false);
    expect(decision.reason).toBe('live-other-instance');
    expect(decision.pid).toBe(11111);
  });

  it('returns stale when the lock points to a dead PID', () => {
    writeLockFile(tmpDir, { pid: 33333 });
    const decision = isStaleTmpDir(tmpDir, {
      ourPid: 44444,
      isProcessAlive: () => false
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toBe('dead-pid');
    expect(decision.pid).toBe(33333);
  });

  it('returns stale when the lock is from our own previous run', () => {
    writeLockFile(tmpDir, { pid: 55555 });
    const decision = isStaleTmpDir(tmpDir, {
      ourPid: 55555,
      isProcessAlive: () => true
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toBe('own-prior-run');
  });

  it('returns stale when no lock and dir mtime is older than threshold', () => {
    fs.writeFileSync(path.join(tmpDir, 'marker'), '');
    const fakeNow = Date.now() + (10 * 60 * 60 * 1000);
    const decision = isStaleTmpDir(tmpDir, {
      now: () => fakeNow,
      staleThresholdMs: 6 * 60 * 60 * 1000
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toBe('mtime-aged');
  });

  it('returns NOT stale when no lock and dir is recent', () => {
    fs.writeFileSync(path.join(tmpDir, 'marker'), '');
    const decision = isStaleTmpDir(tmpDir, {
      staleThresholdMs: 6 * 60 * 60 * 1000
    });
    expect(decision.stale).toBe(false);
    expect(decision.reason).toBe('recent-no-lock');
  });

  it('returns NOT stale when stat fails (e.g., race with another deleter)', () => {
    const decision = isStaleTmpDir(path.join(tmpDir, 'does-not-exist'));
    expect(decision.stale).toBe(false);
    expect(decision.reason).toBe('stat-failed');
  });
});


describe('multi-instance race scenario', () => {
  it('instance B at startup does NOT delete instance A\'s in-flight dir', () => {
    const instanceAPid = 12345;
    const instanceBPid = 67890;
    writeLockFile(tmpDir, { pid: instanceAPid });

    const decision = isStaleTmpDir(tmpDir, {
      ourPid: instanceBPid,
      isProcessAlive: (pid) => pid === instanceAPid
    });

    expect(decision.stale).toBe(false);
  });

  it('instance B at startup DOES delete its own crashed previous run', () => {
    const instanceBPid = 67890;
    writeLockFile(tmpDir, { pid: instanceBPid });

    const decision = isStaleTmpDir(tmpDir, {
      ourPid: instanceBPid,
      isProcessAlive: () => true
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toBe('own-prior-run');
  });

  it('instance B at startup deletes a dir from a long-dead instance A', () => {
    const instanceBPid = 67890;
    writeLockFile(tmpDir, { pid: 12345 });

    const decision = isStaleTmpDir(tmpDir, {
      ourPid: instanceBPid,
      isProcessAlive: () => false
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toBe('dead-pid');
  });
});
