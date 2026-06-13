const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/main.js',
  output: {
    filename: 'bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
    publicPath: '/'
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.wasm$/i,
        type: 'asset/resource'
      }
    ]
  },
  resolve: {
    fallback: {
      crypto: false,
      fs: false,
      path: false
    }
  },
  plugins: [
    new webpack.DefinePlugin({
      __dirname: JSON.stringify('/'),
      __filename: JSON.stringify('/opencascade.full.js')
    }),
    new HtmlWebpackPlugin({
      template: './src/index.html'
    })
  ],
  devServer: {
    static: path.resolve(__dirname, 'dist'),
    hot: true,
    port: 3011
  }
};
