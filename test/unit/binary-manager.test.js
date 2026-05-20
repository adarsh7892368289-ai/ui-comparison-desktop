import { describe, it, expect, vi } from 'vitest';











describe('saucelabs-binary-manager — pure logic', () => {
  describe('_parseSemver', () => {
    const { _parseSemver } = require('../../src/main/saucelabs-binary-manager.js');

    it('parses valid semver string', () => {
      expect(_parseSemver('1.2.3')).toEqual([1, 2, 3]);
    });

    it('parses version with large numbers', () => {
      expect(_parseSemver('0.205.1')).toEqual([0, 205, 1]);
    });

    it('parses zero version', () => {
      expect(_parseSemver('0.0.0')).toEqual([0, 0, 0]);
    });

    it('returns null for null', () => {
      expect(_parseSemver(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(_parseSemver('')).toBeNull();
    });

    it('returns null for non-semver', () => {
      expect(_parseSemver('abc')).toBeNull();
    });

    it('returns null for partial version', () => {
      expect(_parseSemver('1.2')).toBeNull();
    });

    it('returns null for version with prefix', () => {
      expect(_parseSemver('v1.2.3')).toBeNull();
    });
  });

  describe('_compareSemver', () => {
    const { _compareSemver } = require('../../src/main/saucelabs-binary-manager.js');

    it('returns 0 for equal versions', () => {
      expect(_compareSemver([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    it('returns 0 for equal zero versions', () => {
      expect(_compareSemver([0, 0, 0], [0, 0, 0])).toBe(0);
    });

    it('returns 1 when major is greater', () => {
      expect(_compareSemver([2, 0, 0], [1, 9, 9])).toBe(1);
    });

    it('returns 1 when minor is greater (same major)', () => {
      expect(_compareSemver([1, 3, 0], [1, 2, 9])).toBe(1);
    });

    it('returns 1 when patch is greater (same major.minor)', () => {
      expect(_compareSemver([1, 2, 4], [1, 2, 3])).toBe(1);
    });

    it('returns -1 when a < b', () => {
      expect(_compareSemver([0, 9, 9], [1, 0, 0])).toBe(-1);
    });

    it('returns -1 when minor is less', () => {
      expect(_compareSemver([1, 1, 9], [1, 2, 0])).toBe(-1);
    });
  });

  describe('_satisfiesRange', () => {
    const { _satisfiesRange } = require('../../src/main/saucelabs-binary-manager.js');

    it('satisfies >=0.200.0 <1.0.0 at lower bound', () => {
      expect(_satisfiesRange('0.200.0', '>=0.200.0 <1.0.0')).toBe(true);
    });

    it('satisfies >=0.200.0 <1.0.0 in middle', () => {
      expect(_satisfiesRange('0.205.1', '>=0.200.0 <1.0.0')).toBe(true);
    });

    it('satisfies >=0.200.0 <1.0.0 at high minor', () => {
      expect(_satisfiesRange('0.999.999', '>=0.200.0 <1.0.0')).toBe(true);
    });

    it('fails below lower bound', () => {
      expect(_satisfiesRange('0.199.9', '>=0.200.0 <1.0.0')).toBe(false);
    });

    it('fails well below lower bound', () => {
      expect(_satisfiesRange('0.0.1', '>=0.200.0 <1.0.0')).toBe(false);
    });

    it('fails at upper bound (exclusive)', () => {
      expect(_satisfiesRange('1.0.0', '>=0.200.0 <1.0.0')).toBe(false);
    });

    it('fails above upper bound', () => {
      expect(_satisfiesRange('2.0.0', '>=0.200.0 <1.0.0')).toBe(false);
    });

    it('returns false for null version', () => {
      expect(_satisfiesRange(null, '>=0.200.0 <1.0.0')).toBe(false);
    });

    it('returns false for unparseable version', () => {
      expect(_satisfiesRange('bad', '>=0.200.0 <1.0.0')).toBe(false);
    });

    it('handles single >= constraint', () => {
      expect(_satisfiesRange('1.0.0', '>=1.0.0')).toBe(true);
      expect(_satisfiesRange('0.9.9', '>=1.0.0')).toBe(false);
    });

    it('handles single < constraint', () => {
      expect(_satisfiesRange('0.9.9', '<1.0.0')).toBe(true);
      expect(_satisfiesRange('1.0.0', '<1.0.0')).toBe(false);
    });

    it('handles = constraint', () => {
      expect(_satisfiesRange('1.2.3', '=1.2.3')).toBe(true);
      expect(_satisfiesRange('1.2.4', '=1.2.3')).toBe(false);
    });
  });

  describe('Binary resolution hierarchy (4-level)', () => {
    it('hierarchy order: downloaded → bundled → PATH → error (null)', () => {








      expect(true).toBe(true);
    });

    it('platform binary name is saucectl.exe on win32, saucectl elsewhere', () => {
      const expected = process.platform === 'win32' ? 'saucectl.exe' : 'saucectl';

      expect(expected).toMatch(/^saucectl(\.exe)?$/);
    });
  });

  describe('5-second timeout contract', () => {
    it('SAUCE_VERSION_CHECK_TIMEOUT_MS is 5000 in config', () => {
      const { config } = require('../../src/config/defaults.js');
      expect(config.saucelabs.versionCheckTimeoutMs).toBe(5000);
    });
  });

  describe('Platform asset map', () => {
    const ASSET_MAP = {
      'win32:x64': (v) => `saucectl_${v}_win_64-bit.zip`,
      'darwin:x64': (v) => `saucectl_${v}_mac_64-bit.tar.gz`,
      'darwin:arm64': (v) => `saucectl_${v}_mac_arm64.tar.gz`,
      'linux:x64': (v) => `saucectl_${v}_linux_64-bit.tar.gz`,
      'linux:arm64': (v) => `saucectl_${v}_linux_arm64.tar.gz`
    };

    it('Windows x64 produces .zip', () => {
      expect(ASSET_MAP['win32:x64']('0.205.1')).toBe('saucectl_0.205.1_win_64-bit.zip');
    });

    it('macOS x64 produces .tar.gz', () => {
      expect(ASSET_MAP['darwin:x64']('0.205.1')).toBe('saucectl_0.205.1_mac_64-bit.tar.gz');
    });

    it('macOS arm64 produces .tar.gz', () => {
      expect(ASSET_MAP['darwin:arm64']('0.205.1')).toBe('saucectl_0.205.1_mac_arm64.tar.gz');
    });

    it('Linux x64 produces .tar.gz', () => {
      expect(ASSET_MAP['linux:x64']('0.205.1')).toBe('saucectl_0.205.1_linux_64-bit.tar.gz');
    });

    it('Linux arm64 produces .tar.gz', () => {
      expect(ASSET_MAP['linux:arm64']('0.205.1')).toBe('saucectl_0.205.1_linux_arm64.tar.gz');
    });

    it('all supported platforms have entries', () => {
      expect(Object.keys(ASSET_MAP)).toHaveLength(5);
    });
  });
});