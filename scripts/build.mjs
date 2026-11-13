import { build } from 'vite'

await build()
// MCP 的 Node 桥接与界面使用同一份任务逻辑，构建成宿主可 require 的 CommonJS。
await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    lib: { entry: 'src/repository.js', formats: ['cjs'], fileName: () => 'repository.cjs' },
  },
})
