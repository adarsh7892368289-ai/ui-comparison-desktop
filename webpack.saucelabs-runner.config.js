'use strict';

const path = require('path');
const fs = require('fs');

// Builds the SauceLabs runner staging files into dist/saucelabs-runner/.
// Outputs:
//   - keyframe-grouper.js : CJS-bundled grouper (ESM->CJS via webpack).
//   - schemas.js          : CJS-bundled schema validators (used by spec to
//                           fail fast on malformed job.json inside the VM).
//   - extract.spec.js     : copied as-is (Playwright test runner needs to
//                           parse the spec; bundling would obscure it).
//
// extractor-bundle.js is built separately by webpack.extractor.config.js
// and copied into the staging dir at job-submission time (per-platform
// cost trade-off: it's a 150KB asset shared across all SauceLabs jobs).

class CopySpecPlugin {
  constructor(opts) {
    this.from = opts.from;
    this.to = opts.to;
  }
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopySpecPlugin', () => {
      fs.mkdirSync(path.dirname(this.to), { recursive: true });
      fs.copyFileSync(this.from, this.to);
    });
  }
}

module.exports = {
  mode: 'production',
  target: 'node',

  entry: {
    'keyframe-grouper': './src/core/comparison/keyframe-grouper.js',
    'schemas': './src/core/saucelabs-bridge/schemas.js'
  },

  output: {
    path: path.resolve(__dirname, 'dist/saucelabs-runner'),
    filename: '[name].js',
    library: { type: 'commonjs2' }
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', { targets: { node: '18' }, modules: 'commonjs' }]
            ]
          }
        }
      }
    ]
  },

  optimization: {
    minimize: false,
    splitChunks: false,
    runtimeChunk: false
  },

  externals: {
    '@playwright/test': 'commonjs @playwright/test'
  },

  plugins: [
    new CopySpecPlugin({
      from: path.resolve(__dirname, 'src/saucelabs-runner/extract.spec.js'),
      to: path.resolve(__dirname, 'dist/saucelabs-runner/extract.spec.js')
    })
  ],

  devtool: false,
  bail: true
};
