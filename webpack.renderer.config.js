const path = require('path');
const fs   = require('fs');

class CopyIndexHtmlPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyIndexHtmlPlugin', () => {
      const src  = path.resolve(__dirname, 'src/renderer/index.html');
      const dest = path.resolve(__dirname, 'dist/renderer/index.html');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    });
  }
}

module.exports = {
  mode:   process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'web',

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
'electron-log': require.resolve('electron-log/renderer'),
      'electron': path.resolve(__dirname, 'src/renderer/stubs/electron.js'),
    },
  },

  plugins: [new CopyIndexHtmlPlugin()],

  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',

  bail: true,
};