'use strict'

if (process.env.NODE_ENV === 'production') {
  // 生产环境使用压缩版的编译文件
  module.exports = require('./dist/reactivity.cjs.prod.js')
} else {
  module.exports = require('./dist/reactivity.cjs.js')
}
