const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

async function build() {
  const ctx = await esbuild.context({
    entryPoints: ['src/main.ts'],
    outfile: 'main.js',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    target: 'esnext',
    format: 'cjs',
    sourcemap: true,
    minify: !isWatch,
    bundle: true,
    external: ['obsidian'],
  });

  if (isWatch) {
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('Build complete!');
  }
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
