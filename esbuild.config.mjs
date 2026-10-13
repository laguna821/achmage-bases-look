import esbuild from 'esbuild';
import process from 'node:process';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
	entryPoints: ['main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', 'node:*'],
	format: 'cjs',
	target: 'es2022',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	// Keep import() of Node built-ins as require() so the desktop app can load them.
	supported: { 'dynamic-import': false },
	outfile: 'main.js',
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
