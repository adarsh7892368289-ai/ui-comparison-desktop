/* global chrome */
import logger from './logger.js';

export const TabAdapter = {

  async getActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (error) {
      logger.error('Failed to get active tab', { error: error.message });
      return null;
    }
  },

  async createTab(url, active = false, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let listener;
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab creation timeout'));
      }, timeoutMs);

      chrome.tabs.create({ url, active }, (tab) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          return reject(new Error(chrome.runtime.lastError.message));
        }

        listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(tab);
          }
        };

        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  },

  async removeTab(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      logger.warn('Failed to remove tab', { tabId, error: error.message });
    }
  },

  async executeScript(tabId, files) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        files
      });
      return results;
    } catch (error) {
      logger.error('Script execution failed', { tabId, files, error: error.message });
      throw error;
    }
  },

  async sendMessage(tabId, message, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tab message timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timer);

          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || 'Tab message failed';
            return reject(new Error(errorMsg));
          }

          resolve(response);
        });
      } catch (error) {
        clearTimeout(timer);
        const errorMsg = error.message || String(error);
        reject(new Error(`Failed to send message to tab ${tabId}: ${errorMsg}`));
      }
    });
  },

  async query(queryInfo) {
    try {
      return await chrome.tabs.query(queryInfo);
    } catch (error) {
      logger.error('Tab query failed', { queryInfo, error: error.message });
      return [];
    }
  },

  async get(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      logger.warn('Failed to get tab', { tabId, error: error.message });
      return null;
    }
  },

  async getFrames(tabId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return frames ?? [];
    } catch (error) {
      logger.warn('Failed to get frames', { tabId, error: error.message });
      return [];
    }
  }
};

export class PlaywrightTabAdapter {
  #pages    = new Map();
  #sessions = new Map();

  constructor(browserContext) {
    this._context = browserContext;
  }

  async createTab(url) {
    const page  = await this._context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const tabId = crypto.randomUUID();
    this.#pages.set(tabId, page);
    return { tabId, page };
  }

  async removeTab(tabId) {
    const page = this.#pages.get(tabId);
    if (page) {
      await page.close().catch(err => {
        if (!err.message.includes('Target closed') &&
            !err.message.includes('Page closed')) {
          logger.warn('PlaywrightTabAdapter.removeTab error', { tabId, error: err.message });
        }
      });
    }
    this.#pages.delete(tabId);
    this.#sessions.delete(tabId);
  }

  async executeScript(tabId, fn, args) {
    const page = this.#pages.get(tabId);
    if (!page) { throw new Error(`PlaywrightTabAdapter: no page for tabId ${tabId}`); }
    return page.evaluate(fn, args);
  }

  getActiveTab() {
    let lastTabId = null;
    let lastPage  = null;
    for (const [tabId, page] of this.#pages) {
      lastTabId = tabId;
      lastPage  = page;
    }
    if (!lastTabId) { return null; }
    return { tabId: lastTabId, page: lastPage };
  }

  getPage(tabId) {
    return this.#pages.get(tabId) ?? null;
  }

  setSession(tabId, sessionHandle) {
    this.#sessions.set(tabId, sessionHandle);
  }

  getSession(tabId) {
    return this.#sessions.get(tabId) ?? null;
  }

  entries() {
    return this.#pages.entries();
  }

  get size() {
    return this.#pages.size;
  }
}