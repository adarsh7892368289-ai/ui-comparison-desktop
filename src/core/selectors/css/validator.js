
function isValidCssSelector(selector) {
  if (!selector || typeof selector !== 'string') {return false;}

  try {
    document.querySelector(selector);
    return true;
  } catch (error) {
    return false;
  }
}

function isUniqueCssSelector(selector, targetElement) {
  try {
    const matches = document.querySelectorAll(selector);

    if (matches.length !== 1) {return false;}
    return matches[0] === targetElement;
  } catch (error) {
    return false;
  }
}

function escapeCss(str) {
  if (!str) {return '';}

  return str.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

export { isValidCssSelector, isUniqueCssSelector, escapeCss };