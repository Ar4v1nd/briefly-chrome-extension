'use strict';

const { merge } = require('webpack-merge');

const common = require('./webpack.common.js');
const PATHS = require('./paths');

// Merge webpack configuration files
const config = (env, argv) =>
  merge(common, {
    entry: {
      sidepanel: PATHS.src + '/sidepanel.js',
      background: PATHS.src + '/background.js',
    },
    devtool: argv.mode === 'production' ? false : 'source-map',
    resolve: {
      fallback: {
        assert: require.resolve('assert'),
        buffer: require.resolve('buffer'),
        stream: require.resolve('stream-browserify'),
        util: require.resolve('util'),
        zlib: require.resolve('browserify-zlib'),
      }
    }
  });

module.exports = config;
