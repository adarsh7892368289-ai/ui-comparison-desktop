const path = require('path');

module.exports = {
  mode:   process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'electron-main',

  entry: {
    index:   './src/main/index.js',
    preload: './src/main/preload.js',
  },

  output: {
    path:     path.resolve(__dirname, 'dist/main'),
    filename: '[name].js',
  },

  externals: {
    'better-sqlite3': 'commonjs better-sqlite3',
    playwright:       'commonjs playwright',
    'electron-log':   'commonjs electron-log',
    'electron-updater': 'commonjs electron-updater',
  },

  module: {
    rules: [
      {
        test:    /\.js$/,
        exclude: /node_modules/,
        use: {
          loader:  'babel-loader',
          options: {
            presets: [
              [
                '@babel/preset-env',
                {
                  targets: { electron: '33' },
                  modules: 'commonjs',
                },
              ],
            ],
          },
        },
      },
    ],
  },

  resolve: {
    extensions: ['.js'],
    alias: {
      '@core':   path.resolve(__dirname, 'src/core'),
      '@config': path.resolve(__dirname, 'src/config'),
      '@infra':  path.resolve(__dirname, 'src/infrastructure'),
    },
  },

  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',

  bail: true,
};