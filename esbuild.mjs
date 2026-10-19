import { context, build } from 'esbuild'

const isWatch = process.argv.includes('--watch')
const isProduction = process.argv.includes('--production')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
}

if (isWatch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
