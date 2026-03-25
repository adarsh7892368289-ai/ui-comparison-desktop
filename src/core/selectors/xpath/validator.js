/**
 * XPath expression evaluation helpers: syntax validation, match counting,
 * uniqueness checks, and value escaping.
 * Runs in the content-script context; all functions are synchronous and never throw.
 * Invariant: every function returns a primitive — callers need no null-guard.
 * Called by: xpath/generator.js and xpath/strategies.js.
 */

/**
 * Returns true when `xpath` is syntactically valid according to the browser's XPath engine.
 * Uses `document.evaluate` as the parser oracle — invalid expressions throw.
 *
 * @param {string|*} xpath
 * @returns {boolean}
 */
function isValidXPath(xpath) {
  if (!xpath || typeof xpath !== 'string') {return false;}
  try {
    document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Returns the number of nodes matched by `xpath` in `context`.
 * Returns 0 on evaluation error so callers can treat it as a miss.
 *
 * @param {string} xpath
 * @param {Node} context - Default is `document`.
 * @returns {number}
 */
function countXPathMatches(xpath, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    return result.snapshotLength;
  } catch (_) {
    return 0;
  }
}

/**
 * Returns true when the first node matched by `xpath` is `targetElement`.
 * Does not require the match to be unique — use `isUniqueXPath` for that.
 *
 * @param {string} xpath
 * @param {Element} targetElement
 * @param {Node} context
 * @returns {boolean}
 */
function xpathPointsToElement(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    if (result.snapshotLength === 0) {return false;}
    return result.snapshotItem(0) === targetElement;
  } catch (_) {
    return false;
  }
}

/**
 * Returns true when `xpath` matches exactly one node and that node is `targetElement`.
 * Both conditions must hold — a unique match on the wrong element is a failure.
 *
 * @param {string} xpath
 * @param {Element} targetElement
 * @param {Node} context
 * @returns {boolean}
 */
function isUniqueXPath(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    return result.snapshotLength === 1 && result.snapshotItem(0) === targetElement;
  } catch (_) {
    return false;
  }
}

/**
 * Appends a positional index predicate `[N]` to `xpath` when it matches multiple nodes,
 * so that the returned expression uniquely identifies `targetElement`.
 * Returns the original `xpath` unchanged when it already resolves to a single node
 * or when `targetElement` is not found in the result set.
 *
 * @param {string} xpath
 * @param {Element} targetElement
 * @param {Node} context
 * @returns {string} Disambiguated XPath, or the original on failure.
 */
function ensureUniqueness(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    for (let i = 0; i < result.snapshotLength; i++) {
      if (result.snapshotItem(i) === targetElement) {
        if (result.snapshotLength === 1) {return xpath;}
        return `(${xpath})[${i + 1}]`;
      }
    }
  } catch (_) {
    // Swallow — fall through to return original xpath.
  }
  return xpath;
}

/**
 * Wraps `str` in XPath-safe quotes, handling strings that contain both `'` and `"` by
 * building a `concat(…)` expression. Converts non-strings to strings before escaping.
 *
 * @param {string|null|undefined|*} str
 * @returns {string} XPath string literal expression.
 */
function escapeXPath(str) {
  if (str === null || str === undefined) {return "''";}
  if (typeof str !== 'string') {str = String(str);}
  if (str === '') {return "''";}

  if (!str.includes("'")) {return `'${str}'`;}
  if (!str.includes('"')) {return `"${str}"`;}

  // String contains both quote types — use XPath concat() to avoid unescaped quotes.
  const parts = str.split("'");
  return `concat('${parts.join("', \"'\", '")}')`;
}

export {
  countXPathMatches, ensureUniqueness,
  escapeXPath, isUniqueXPath, isValidXPath, xpathPointsToElement
};