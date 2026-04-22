'use strict';






function mainDistributionDir() {
  const d = __dirname;
  if (d.includes('app.asar')) {
    return d.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
  }
  return d;
}

module.exports = { mainDistributionDir };