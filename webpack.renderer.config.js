const path = require('path');

module.exports = {
  mode:   process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'electron-renderer',

  entry: {
    app: './src/renderer/app.js',
  },

  output: {
    path:     path.resolve(__dirname, 'dist/renderer'),
    filename: '[name].js',
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
                  targets: { chrome: '120' },
                  modules: false,
                },
              ],
            ],
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
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