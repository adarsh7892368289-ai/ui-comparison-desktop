import { get } from '../../config/defaults.js';
const T3_TAGS = new Set([
  'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'A', 'DIALOG',
  'DETAILS', 'OUTPUT', 'METER', 'PROGRESS', 'OPTION', 'OPTGROUP'
]);

const T3_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem', 'gridcell'
]);

const T2_TAGS = new Set([
  'P', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'SVG',
  'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'BLOCKQUOTE', 'PRE', 'CODE',
  'STRONG', 'EM', 'FIGURE', 'FIGCAPTION', 'TIME', 'ADDRESS', 'Q',
  'MARK', 'INS', 'DEL', 'ABBR', 'CITE', 'DFN', 'KBD', 'SAMP', 'VAR',
  'SMALL', 'SUB', 'SUP', 'DL', 'DT', 'DD', 'IFRAME'
]);

let t0TagsCache = null;
function getT0Tags() {
  if (!t0TagsCache) {
    t0TagsCache = new Set(get('extraction.irrelevantTags'));
  }
  return t0TagsCache;
}

function isTierZero(element) {
  return getT0Tags().has(element.tagName);
}

function classifyTier(element) {
  const { tagName } = element;

  if (getT0Tags().has(tagName)) {return 'T0';}
  if (T3_TAGS.has(tagName))    {return 'T3';}

  const role = element.getAttribute('role');
  if (role && T3_ROLES.has(role)) {return 'T3';}
  if (T2_TAGS.has(tagName))       {return 'T2';}
  return 'T1';
}

function isVisible(computedStyle, rect) {
  if (!computedStyle) {return false;}
  return (
    computedStyle.display     !== 'none'   &&
    computedStyle.visibility  !== 'hidden' &&
    parseFloat(computedStyle.opacity) > 0  &&
    rect.width  > 0 &&
    rect.height > 0
  );
}

export { isTierZero, classifyTier, isVisible, getT0Tags };