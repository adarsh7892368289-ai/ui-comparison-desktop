'use strict';

const path = require('path');
const fs = require('fs');


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
