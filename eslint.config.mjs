import tseslint from 'typescript-eslint';
export default tseslint.config(
	{ ignores: ['out/**', 'dist/**', 'node_modules/**'] },
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: { parser: tseslint.parser },
		plugins: { '@typescript-eslint': tseslint.plugin },
		rules: {
			eqeqeq: 'error',
			curly: 'error',
			'no-throw-literal': 'error',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
		},
	},
);
