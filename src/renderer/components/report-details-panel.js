'use strict';

import { hostFromUrl, lastPathSegment, envTag } from '../utils/report-metadata.js';
import { absoluteCalendarDate, relativeTime } from '../utils/time.js';
import { iconCheck, iconAlertTriangle, iconMonitor, iconSmartphone, iconTablet } from '../utils/icons.js';
import { Toast } from './toast.js';

function _el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function _isPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function _formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)} s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec - mins * 60);
  return `${mins}m ${remSec}s`;
}

function _formatPlatform(p) {
  if (!p) return '';
  const s = String(p).toLowerCase();
  if (s === 'win32') return 'Windows';
  if (s === 'darwin') return 'macOS';
  if (s === 'linux') return 'Linux';
  return p;
}

function _osFamilyFromPlatform(p) {
  if (!p) return null;
  const s = String(p).toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('mac')) return 'macOS';
  if (s.includes('linux')) return 'Linux';
  if (s.includes('android')) return 'Android';
  if (s.includes('ios') || s.includes('iphone') || s.includes('ipad')) return 'iOS';
  return null;
}

function _formatRegion(r) {
  if (!r) return '';
  const map = {
    'us-west-1': 'US West (Oregon)',
    'us-east-4': 'US East (Virginia)',
    'eu-central-1': 'EU Central (Frankfurt)',
    'apac-southeast-1': 'APAC Southeast (Singapore)'
  };
  return map[r] || r;
}

function _formatEngine(engine) {
  if (!engine) return '';
  const map = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
  const k = String(engine).toLowerCase();
  return map[k] || engine;
}

const _DEVICE_ICONS = { phone: iconSmartphone, tablet: iconTablet, desktop: iconMonitor };
const _DEVICE_LABELS = { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };

function _resolveDeviceType(report) {
  const t = report.captureConfig && report.captureConfig.deviceType;
  if (t === 'phone' || t === 'tablet' || t === 'desktop') return t;

  const sauceDevice = report.sauce && report.sauce.device;
  if (sauceDevice && (sauceDevice.isMobile || sauceDevice.name)) {
    const name = String(sauceDevice.name || '');
    if (/iPad|Tablet|Nexus 7|Nexus 10|SM-T|Galaxy Tab/i.test(name)) return 'tablet';
    const vp = sauceDevice.viewport;
    if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
      return Math.min(vp.width, vp.height) >= 600 ? 'tablet' : 'phone';
    }
    return 'phone';
  }
  if (report.sauce && !sauceDevice) return 'desktop';
  return null;
}

function _deviceIcon(deviceType, size = 14) {
  const fn = _DEVICE_ICONS[deviceType] || iconMonitor;
  return fn(size);
}

function _copyButton(value, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'report-details__copy-btn';
  btn.title = `Copy ${label || 'value'}`;
  btn.setAttribute('aria-label', `Copy ${label || 'value'}`);
  btn.innerHTML = _copyIconSvg();
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(value));
      btn.innerHTML = iconCheck(14);
      btn.classList.add('report-details__copy-btn--copied');
      Toast.success('Copied to clipboard');
      setTimeout(() => {
        btn.innerHTML = _copyIconSvg();
        btn.classList.remove('report-details__copy-btn--copied');
      }, 1500);
    } catch {
      Toast.error('Could not copy to clipboard');
    }
  });
  return btn;
}

function _copyIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

function _monoValueWithCopy(value, label) {
  const wrap = _el('div', 'report-details__value-row');
  const span = _el('span', 'report-details__value report-details__value--mono', value);
  span.title = String(value);
  wrap.appendChild(span);
  wrap.appendChild(_copyButton(value, label));
  return wrap;
}

function _plainValue(text) {
  const span = _el('span', 'report-details__value', text);
  return span;
}

function _chip(text, title) {
  const c = _el('span', 'report-details__chip', text);
  if (title) c.title = title;
  return c;
}

function _addRow(dl, label, valueNode) {
  if (valueNode == null) return;
  const dt = _el('dt', 'report-details__label', label);
  const dd = _el('dd', 'report-details__value-cell');
  dd.appendChild(valueNode);
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function _section(title) {
  const section = _el('section', 'report-details__group');
  section.appendChild(_el('h4', 'report-details__group-title', title));
  const dl = _el('dl', 'report-details__list');
  section.appendChild(dl);
  return { section, dl };
}

function _buildSourceSection(report) {
  const { section, dl } = _section('Source');
  const url = report.url || '';
  if (url) {
    _addRow(dl, 'URL', _monoValueWithCopy(url, 'URL'));
  }
  const host = hostFromUrl(url);
  if (host) _addRow(dl, 'Host', _plainValue(host));
  const path = lastPathSegment(url);
  if (path) _addRow(dl, 'Path', _plainValue(path));
  const env = report.environment?.trim() || envTag(url);
  if (env) {
    const chip = _chip(env, 'Environment');
    chip.classList.add('report-details__chip--env', `report-details__chip--env-${env.toLowerCase()}`);
    _addRow(dl, 'Environment', chip);
  }
  return dl.children.length > 0 ? section : null;
}

function _buildExtractionSection(report) {
  const { section, dl } = _section('Extraction');

  const engine = _formatEngine(report.engine);
  if (engine) _addRow(dl, 'Browser engine', _plainValue(engine));

  const platform = _formatPlatform(report.platform);
  if (platform) _addRow(dl, 'Platform', _plainValue(platform));

  if (typeof report.totalElements === 'number') {
    _addRow(dl, 'Elements captured', _plainValue(String(report.totalElements)));
  }

  if (report.captureQuality) {
    const isDegraded = String(report.captureQuality).toUpperCase() === 'DEGRADED';
    const wrap = _el('div', 'report-details__value-row');
    const text = isDegraded ? 'Degraded' : 'Normal';
    const chip = _chip(text);
    if (isDegraded) {
      chip.classList.add('report-details__chip--warn');
      const ico = document.createElement('span');
      ico.className = 'report-details__chip-icon';
      ico.innerHTML = iconAlertTriangle(12);
      chip.prepend(ico);
      chip.title = 'Page was still loading when capture completed';
    }
    wrap.appendChild(chip);
    _addRow(dl, 'Capture quality', wrap);
  }

  const dur = _formatDuration(report.duration);
  if (dur) _addRow(dl, 'Duration', _plainValue(dur));

  const filters = report.filters
    || (report.filterClass || report.filterId || report.filterTag
      ? { class: report.filterClass, id: report.filterId, tag: report.filterTag }
      : null);
  if (filters && (filters.class || filters.id || filters.tag)) {
    const wrap = _el('div', 'report-details__chip-row');
    if (filters.class) wrap.appendChild(_chip(`class: ${filters.class}`, 'CSS class filter'));
    if (filters.id) wrap.appendChild(_chip(`id: ${filters.id}`, 'CSS id filter'));
    if (filters.tag) wrap.appendChild(_chip(`tag: ${filters.tag}`, 'HTML tag filter'));
    _addRow(dl, 'Filters', wrap);
  }

  const source = report.source;
  if (source) {
    const labelMap = { imported: 'Imported from file', saucelabs: 'SauceLabs cloud', local: 'Local extraction' };
    _addRow(dl, 'Source', _plainValue(labelMap[source] || source));
  }

  return dl.children.length > 0 ? section : null;
}

function _buildCaptureConfigSection(report) {
  const cfg = report.captureConfig;
  if (!cfg || !_isPresent(cfg)) return null;
  const { section, dl } = _section('Capture configuration');

  const deviceType = _resolveDeviceType(report);
  if (deviceType) {
    const wrap = _el('div', 'report-details__chip-row');
    const chip = _chip(_DEVICE_LABELS[deviceType] || deviceType, 'Form factor');
    chip.classList.add('report-details__chip--accent');
    const ico = _el('span', 'report-details__chip-icon');
    ico.innerHTML = _deviceIcon(deviceType, 12);
    chip.prepend(ico);
    wrap.appendChild(chip);
    _addRow(dl, 'Device', wrap);
  }

  if (cfg.deviceName) {
    _addRow(dl, 'Model', _plainValue(cfg.deviceName));
  }

  const vp = cfg.viewport;
  if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
    _addRow(dl, 'Viewport', _plainValue(`${vp.width} × ${vp.height}`));
  }

  if (cfg.screenResolution) {
    _addRow(dl, 'Screen', _plainValue(cfg.screenResolution));
  }

  if (typeof cfg.devicePixelRatio === 'number' && cfg.devicePixelRatio > 0) {
    _addRow(dl, 'Pixel ratio', _plainValue(`${cfg.devicePixelRatio}×`));
  }

  if (cfg.orientation) {
    _addRow(dl, 'Orientation',
      _plainValue(cfg.orientation.charAt(0).toUpperCase() + cfg.orientation.slice(1)));
  }

  if (typeof cfg.hasTouch === 'boolean') {
    _addRow(dl, 'Touch', _plainValue(cfg.hasTouch ? 'Enabled' : 'Disabled'));
  }

  if (cfg.userAgent) {
    _addRow(dl, 'User agent', _monoValueWithCopy(cfg.userAgent, 'user agent'));
  }

  return dl.children.length > 0 ? section : null;
}

function _buildCloudSection(report) {
  const sauce = report.sauce;
  if (!sauce || !_isPresent(sauce)) return null;
  const { section, dl } = _section('Cloud execution · SauceLabs');

  const device = sauce.device;
  const isMobile = !!(device && (device.isMobile || device.name));

  if (sauce.region) {
    _addRow(dl, 'Region', _plainValue(_formatRegion(sauce.region)));
  }

  const osFamily = _osFamilyFromPlatform(sauce.platform);
  if (sauce.platform) {
    const wrap = _el('div', 'report-details__value-row');
    wrap.appendChild(_plainValue(sauce.platform));
    if (osFamily && osFamily !== sauce.platform) {
      wrap.appendChild(_chip(osFamily, 'OS family'));
    }
    _addRow(dl, isMobile ? 'OS' : 'Operating system', wrap);
  } else if (osFamily) {
    _addRow(dl, 'Operating system', _plainValue(osFamily));
  }

  if (sauce.browserName) {
    _addRow(dl, 'Browser', _plainValue(_formatEngine(sauce.browserName)));
  }

  if (sauce.playwrightVersion) {
    _addRow(dl, 'Playwright', _plainValue(sauce.playwrightVersion));
  }

  const sessionId = sauce.sessionId || report.sauceSessionId;
  if (sessionId) _addRow(dl, 'Session ID', _monoValueWithCopy(sessionId, 'session ID'));

  const jobId = sauce.jobId || report.sauceJobId;
  if (jobId) _addRow(dl, 'Job ID', _monoValueWithCopy(jobId, 'job ID'));

  if (sauce.buildName) _addRow(dl, 'Build', _plainValue(sauce.buildName));

  if (Array.isArray(sauce.tags) && sauce.tags.length > 0) {
    const wrap = _el('div', 'report-details__chip-row');
    for (const tag of sauce.tags) wrap.appendChild(_chip(tag, 'Tag'));
    _addRow(dl, 'Tags', wrap);
  }

  if (sauce.tunnelName) {
    const text = sauce.tunnelOwner ? `${sauce.tunnelName} (${sauce.tunnelOwner})` : sauce.tunnelName;
    _addRow(dl, 'Tunnel', _plainValue(text));
  }

  if (sauce.visibility) {
    const v = String(sauce.visibility);
    _addRow(dl, 'Visibility', _plainValue(v.charAt(0).toUpperCase() + v.slice(1)));
  }
  if (typeof sauce.timeout === 'number') _addRow(dl, 'Timeout', _plainValue(`${sauce.timeout}s`));

  return dl.children.length > 0 ? section : null;
}

function _buildBulkSection(report, jobMeta) {
  if (!report.bulkJobId) return null;
  const { section, dl } = _section('Bulk job');

  _addRow(dl, 'Job ID', _monoValueWithCopy(report.bulkJobId, 'job ID'));

  if (typeof report.pairIndex === 'number') {
    _addRow(dl, 'Pair index', _plainValue(`#${report.pairIndex + 1}`));
  }

  const meta = jobMeta && jobMeta.get ? jobMeta.get(report.bulkJobId) : null;
  if (meta) {
    if (meta.filename) _addRow(dl, 'Source file', _plainValue(meta.filename));
    if (typeof meta.totalPairs === 'number') _addRow(dl, 'Total pairs', _plainValue(String(meta.totalPairs)));
    if (typeof meta.concurrency === 'number') _addRow(dl, 'Concurrency', _plainValue(String(meta.concurrency)));
    if (typeof meta.hostCooldownMs === 'number') {
      _addRow(dl, 'Host cooldown', _plainValue(`${meta.hostCooldownMs} ms`));
    }
    if (meta.status) {
      const chip = _chip(meta.status);
      chip.classList.add(`report-details__chip--status-${meta.status}`);
      _addRow(dl, 'Job status', chip);
    }
  }

  if (report.deduped && report.deduped !== 'none') {
    _addRow(dl, 'Deduplication', _plainValue(report.deduped));
  }

  return dl.children.length > 0 ? section : null;
}

function _buildIdentifiersSection(report) {
  const { section, dl } = _section('Identifiers');

  if (report.id) {
    _addRow(dl, 'Report ID', _monoValueWithCopy(report.id, 'report ID'));
  }

  if (report.extractionKey) {
    _addRow(dl, 'Extraction key', _monoValueWithCopy(report.extractionKey, 'extraction key'));
  }

  if (report.timestamp) {
    const abs = absoluteCalendarDate(report.timestamp);
    const rel = relativeTime(report.timestamp);
    const wrap = _el('div', 'report-details__value-row report-details__value-row--stacked');
    if (abs) wrap.appendChild(_plainValue(abs));
    if (rel) {
      const sub = _el('span', 'report-details__value report-details__value--sub', rel);
      wrap.appendChild(sub);
    }
    _addRow(dl, 'Captured', wrap);
  }

  return dl.children.length > 0 ? section : null;
}

export function getReportDeviceInfo(report) {
  if (!report) return null;
  const deviceType = _resolveDeviceType(report);
  if (!deviceType) return null;
  return {
    deviceType,
    label: _DEVICE_LABELS[deviceType] || deviceType,
    iconSvg: (size = 14) => _deviceIcon(deviceType, size)
  };
}

export function buildReportDetailsPanel(report, jobMeta) {
  const root = _el('div', 'report-details');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Report details');

  const sections = [
    _buildSourceSection(report),
    _buildExtractionSection(report),
    _buildCaptureConfigSection(report),
    _buildCloudSection(report),
    _buildBulkSection(report, jobMeta),
    _buildIdentifiersSection(report),
  ].filter(Boolean);

  for (const s of sections) root.appendChild(s);

  if (sections.length === 0) {
    const empty = _el('p', 'report-details__placeholder', 'No additional metadata available for this report.');
    root.appendChild(empty);
  }

  return root;
}
