const path = require('path');
const fs   = require('fs');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

class CopyStaticAssetsPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyStaticAssetsPlugin', () => {
      const rendererSrc  = path.resolve(__dirname, 'src/renderer');
      const rendererDest = path.resolve(__dirname, 'dist/renderer');

      fs.mkdirSync(rendererDest, { recursive: true });

      fs.copyFileSync(
        path.join(rendererSrc,  'index.html'),
        path.join(rendererDest, 'index.html')
      );

      copyDirSync(
        path.join(rendererSrc,  'styles'),
        path.join(rendererDest, 'styles')
      );
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
      '@core':        path.resolve(__dirname, 'src/core'),
      '@config':      path.resolve(__dirname, 'src/config'),
      '@infra':       path.resolve(__dirname, 'src/infrastructure'),
      'electron-log': require.resolve('electron-log/renderer'),
      'electron':     path.resolve(__dirname, 'src/renderer/stubs/electron.js'),
    },
  },

  plugins: [new CopyStaticAssetsPlugin()],

  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',

  bail: true,
};