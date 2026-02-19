/**
 * webpack.config.js
 *
 * Builds the Chessable TTS Chrome extension into /dist:
 *
 *   src/content.ts  ─────┐
 *   src/chess-notation.ts ┘ → dist/content.js   (bundled together)
 *
 *   src/popup.ts ──────────→ dist/popup.js
 *
 *   public/**  ────────────→ dist/**  (manifest, HTML, icons — copied as-is)
 *
 * Load the /dist folder in chrome://extensions with Developer Mode on.
 */

const path              = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/** @type {(env: any, argv: { mode: string }) => import('webpack').Configuration} */
module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    // ── Entry points ──────────────────────────────────────────────────────────
    entry: {
      content: './src/content.ts',   // injected into Chessable pages
      popup:   './src/popup.ts',     // the extension popup
    },

    // ── Output ────────────────────────────────────────────────────────────────
    output: {
      path:     path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean:    true,
    },

    // ── Resolution ────────────────────────────────────────────────────────────
    resolve: {
      extensions: ['.ts', '.js'],
    },

    // ── Loaders ───────────────────────────────────────────────────────────────
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: path.resolve(__dirname, 'tsconfig.json'),
              // noEmit:true in tsconfig is only for `npm run typecheck`.
              // webpack needs ts-loader to actually emit code, so we override it.
              compilerOptions: { noEmit: false },
              // In dev/watch mode, skip full type-checking for faster rebuilds.
              // Run `npm run typecheck` separately for a full check.
              transpileOnly: isDev,
            },
          },
          exclude: /node_modules/,
        },
      ],
    },

    // ── Source maps ───────────────────────────────────────────────────────────
    // inline-source-map embeds the map inside the JS (MV3 blocks .map requests)
    devtool: isDev ? 'inline-source-map' : false,

    // ── Static assets ─────────────────────────────────────────────────────────
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'public', to: '.' },
        ],
      }),
    ],

    // ── Optimisation ──────────────────────────────────────────────────────────
    // Keep bundles self-contained — Chrome MV3 can't lazy-load shared chunks
    // without a background service worker as a module loader.
    optimization: {
      splitChunks:  false,
      runtimeChunk: false,
    },

    // ── Stats ─────────────────────────────────────────────────────────────────
    stats: {
      assets:  true,
      modules: false,
      colors:  true,
    },
  };
};
