import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default defineConfig([
	{ ignores: ['main.js', 'node_modules/**', 'tests/**', 'scripts/**', 'esbuild.config.mjs'] },
	...obsidianmd.configs.recommendedWithLocalesEn,
	{
		files: ['**/*.ts'],
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: { allowDefaultProject: ['eslint.config.*'] },
			},
		},
		rules: {
			'obsidianmd/ui/sentence-case': ['error', { brands: ['Bases', 'Eagle', 'Cloudflare', 'R2', 'Obsidian'], acronyms: ['URL', 'API', 'R2'] }],
		},
	},
]);
