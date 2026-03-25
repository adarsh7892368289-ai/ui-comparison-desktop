'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch, subscribe, getState } from './state.js';

const api = window.electronAPI;
if (!api) {
  throw new Error(
    'window.electronAPI is undefined. ' +
    'Verify that preload.js path in BrowserWindow.webPreferences is correct ' +
    'and that contextIsolation: true is set.'
  );
}

async function init() {
  await storage.applyPendingOperations();

  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });

  _registerIPCListeners();

  render();
  subscribe(render);
}

function _registerIPCListeners() {
  api.onComparisonProgress((data) => {
    dispatch('COMPARISON_PROGRESS', { label: data.label, pct: data.pct });
  });

  api.onComparisonComplete((data) => {
    dispatch('COMPARISON_COMPLETE', { result: data.result });
  });

  api.onComparisonError((data) => {
    dispatch('COMPARISON_ERROR', { error: data.error });
  });

  api.onExtractionProgress((data) => {
    dispatch('EXTRACTION_PROGRESS', { label: data.label, pct: data.pct });
  });
}

async function handleStartComparison(baselineId, compareId, mode, includeScreenshots) {
  dispatch('COMPARISON_STARTED', { baselineId, compareId, mode });

  try {
    const reports = getState().reports;
    const baseline = reports.find(r => r.id === baselineId);
    const compare  = reports.find(r => r.id === compareId);

    if (!baseline || !compare) {
      throw new Error('Report not found — reload the reports list and try again');
    }

    await api.startComparison({
      baselineId,
      compareId,
      mode,
      baselineUrl:      baseline.url,
      compareUrl:       compare.url,
      includeScreenshots,
    });

  } catch (error) {
    dispatch('COMPARISON_ERROR', { error: error.message });
  }
}

async function handleLoadReports() {
  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });
}

async function handleDeleteReport(reportId) {
  const cached = await storage.loadComparisonByPair?.(reportId, null, null);

  const result = await storage.deleteReport(reportId);
  if (result.success) {
    dispatch('REPORT_DELETED', { reportId });

    if (cached?.id) {
      await api.unregisterBlobsByComparison(cached.id);
    }
  }
  return result;
}

async function handleExportHTML(baselineId, compareId, mode) {
  dispatch('EXPORT_STARTED');

  try {
    const { htmlContent, filename } = await buildHTMLReport(baselineId, compareId, mode);
    const result = await api.exportHTML({ htmlContent, filename });
    dispatch('EXPORT_COMPLETE', { success: result.success, filePath: result.filePath });
  } catch (error) {
    dispatch('EXPORT_ERROR', { error: error.message });
  }
}

async function buildHTMLReport(baselineId, compareId, mode) {
  throw new Error('buildHTMLReport: Phase 2 — import and call compare-workflow.js exportComparisonAsHTML here');
}

async function registerBlobWithProtocolHandler(blobId, blob) {
  const buffer = await blob.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  const chunk  = 0x8000;
  let binary   = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  await api.registerBlob({ blobId, base64, mimeType: blob.type || 'image/webp' });
}

function render() {
  const state = getState();
  const root  = document.getElementById('app');
  if (!root) { return; }
  root.textContent = `UI Comparison Desktop — Phase 2 UI pending. State: ${state.phase}`;
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('App init failed:', err);
    const root = document.getElementById('app');
    if (root) { root.textContent = `Startup error: ${err.message}`; }
  });
});

export {
  handleStartComparison,
  handleLoadReports,
  handleDeleteReport,
  handleExportHTML,
  registerBlobWithProtocolHandler,
};