import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// Shared formatting rules: https://github.com/julie-ng/ai-native-sdlc-platform-services/blob/main/eslint.config.mjs
// Use this service's TypeScript base instead of Nuxt's generated config.
export default defineConfig([
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'docs-site/dist/**',
      'docs-site/.astro/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      'curly': ['error', 'all'],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/brace-style': ['error', '1tbs'],
      '@stylistic/indent': ['error', 2],
      '@stylistic/object-property-newline': 'error',
      '@stylistic/object-curly-newline': [
        'error',
        {
          ObjectExpression: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
          ObjectPattern: {
            multiline: true,
            minProperties: 3,
            consistent: true,
          },
          TSTypeLiteral: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
          TSInterfaceBody: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
        },
      ],
      // Keep short lists compact; expand arrays with 3+ or multiline elements.
      '@stylistic/array-bracket-newline': [
        'error',
        {
          multiline: true,
          minItems: 3,
        },
      ],
      '@stylistic/array-element-newline': [
        'error',
        {
          multiline: true,
          minItems: 3,
        },
      ],
      '@stylistic/member-delimiter-style': [
        'error',
        {
          multiline: {
            delimiter: 'none',
            requireLast: true,
          },
        },
      ],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
    },
  },
])
