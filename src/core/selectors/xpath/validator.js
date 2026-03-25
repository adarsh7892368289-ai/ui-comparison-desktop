
function isValidXPath(xpath) {
  if (!xpath || typeof xpath !== 'string') {return false;}
  try {
    document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
    return true;
  } catch (_) {
    return false;
  }
}

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
  }
  return xpath;
}

function escapeXPath(str) {
  if (str === null || str === undefined) {return "''";}
  if (typeof str !== 'string') {str = String(str);}
  if (str === '') {return "''";}

  if (!str.includes("'")) {return `'${str}'`;}
  if (!str.includes('"')) {return `"${str}"`;}

  const parts = str.split("'");
  return `concat('${parts.join("', \"'\", '")}')`;
}

export {
  countXPathMatches, ensureUniqueness,
  escapeXPath, isUniqueXPath, isValidXPath, xpathPointsToElement
};