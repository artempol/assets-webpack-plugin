var fs = require('fs')
var path = require('path')
var _ = require('lodash')

var getAssetKind = require('./lib/getAssetKind')
var isHMRUpdate = require('./lib/isHMRUpdate')
var isSourceMap = require('./lib/isSourceMap')

var createQueuedWriter = require('./lib/output/createQueuedWriter')
var createOutputWriter = require('./lib/output/createOutputWriter')

var getHashCode = function (str) {
  var hash = 0
  var len = str.length

  if (len === 0) return hash

  for (var i = 0; i < len; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0 // Convert to 32bit integer
  }

  return hash
}

var getServerNumber = function (resourceUrl, serverCount) {
  var INT_32_MAX_VAL = 2147483647
  var hash = Math.abs(getHashCode(resourceUrl))
  var hashPosition = hash / INT_32_MAX_VAL

  return Math.round((serverCount - 1) * hashPosition)
}

function AssetsWebpackPlugin (options) {
  this.options = _.merge({}, {
    filename: 'webpack-assets.json',
    prettyPrint: false,
    update: false,
    fullPath: true,
    manifestFirst: true,
    useCompilerPath: false,
    fileTypes: ['js', 'css'],
    includeAllFileTypes: true,
    keepInMemory: false,
    integrity: false,
    hosts: []
  }, options)
  this.writer = createQueuedWriter(createOutputWriter(this.options))
}

AssetsWebpackPlugin.prototype = {
  constructor: AssetsWebpackPlugin,

  apply: function (compiler) {
    var self = this

    self.options.path = path.resolve(self.options.useCompilerPath
      ? (compiler.options.output.path || '.') : (self.options.path || '.'))

    var afterEmit = (compilation, callback) => {
      var options = compiler.options
      var stats = compilation.getStats().toJson({
        hash: true,
        publicPath: true,
        assets: true,
        chunks: false,
        modules: false,
        source: false,
        errorDetails: false,
        timings: false
      })
      // publicPath with resolved [hash] placeholder

      var assetPath = (stats.publicPath && self.options.fullPath) ? stats.publicPath : ''
      // assetsByChunkName contains a hash with the bundle names and the produced files
      // e.g. { one: 'one-bundle.js', two: 'two-bundle.js' }
      // in some cases (when using a plugin or source maps) it might contain an array of produced files
      // e.g. {
      // main:
      //   [ 'index-bundle-42b6e1ec4fa8c5f0303e.js',
      //     'index-bundle-42b6e1ec4fa8c5f0303e.js.map' ]
      // }

      var hosts = Array.isArray(self.options.hosts) ? self.options.hosts : []
      var seenAssets = {}
      var chunks

      if (self.options.entrypoints) {
        chunks = Object.keys(stats.entrypoints)
      } else {
        chunks = Object.keys(stats.assetsByChunkName)
        chunks.push('') // push "unamed" chunk
      }

      var output = chunks.reduce(function (chunkMap, chunkName) {
        var assets

        if (self.options.entrypoints) {
          assets = stats.entrypoints[chunkName].assets
        } else {
          assets = chunkName ? stats.assetsByChunkName[chunkName] : stats.assets
        }

        if (!Array.isArray(assets)) {
          assets = [assets]
        }
        var added = false
        var typeMap = assets.reduce(function (typeMap, obj) {
          var asset = obj.name || obj
          if (isHMRUpdate(options, asset) || isSourceMap(options, asset) || (!chunkName && seenAssets[asset])) {
            return typeMap
          }

          var typeName = getAssetKind(options, asset)
          if (self.options.includeAllFileTypes || self.options.fileTypes.includes(typeName)) {
            var combinedPath = assetPath && assetPath.slice(-1) !== '/' ? `${assetPath}/${asset}` : assetPath + asset
            var type = typeof typeMap[typeName]
            var compilationAsset = compilation.assets[asset]
            var integrity = compilationAsset && compilationAsset.integrity
            var prepend = hosts.length !== 0 ? '//' + hosts[getServerNumber(asset, hosts.length)] : ''
            var prependedPath = prepend + combinedPath

            if (type === 'undefined') {
              typeMap[typeName] = prependedPath

              if (self.options.integrity && integrity) {
                typeMap[typeName + 'Integrity'] = integrity
              }
            } else {
              if (type === 'string') {
                typeMap[typeName] = [typeMap[typeName]]
              }
              typeMap[typeName].push(prependedPath)
            }

            added = true
            seenAssets[asset] = true
          }
          return typeMap
        }, {})

        if (added) {
          chunkMap[chunkName] = typeMap
        }
        return chunkMap
      }, {})

      var manifestName = self.options.includeManifest === true ? 'manifest' : self.options.includeManifest
      if (manifestName) {
        var manifestEntry = output[manifestName]
        if (manifestEntry) {
          var js = manifestEntry.js
          if (!Array.isArray(js)) {
            js = [js]
          }
          var manifestAssetKey = js[js.length - 1].substr(assetPath.length)
          var parentSource = compilation.assets[manifestAssetKey]
          var entryText = parentSource.source()
          if (!entryText) {
            throw new Error('Could not locate manifest function in source', parentSource)
          }
          manifestEntry.text = entryText
        }
      }

      if (self.options.metadata) {
        output.metadata = self.options.metadata
      }

      if (!compiler.outputFileSystem.readFile) {
        compiler.outputFileSystem.readFile = fs.readFile.bind(fs)
        compiler.outputFileSystem.join = path.join.bind(path)
      }

      self.writer(compiler.outputFileSystem, output, function (err) {
        if (err) {
          compilation.errors.push(err)
        }
        callback()
      })
    }

    if (compiler.hooks) {
      var plugin = { name: 'AssetsWebpackPlugin' }

      compiler.hooks.afterEmit.tapAsync(plugin, afterEmit)
    } else {
      compiler.plugin('after-emit', afterEmit)
    }
  }
}

module.exports = AssetsWebpackPlugin
