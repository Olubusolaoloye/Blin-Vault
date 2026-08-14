import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Lint rules here are not style preferences — several of them enforce the
 * invariants in CLAUDE.md and fail the build when violated.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/**', '**/dist/**', '**/build/**', 'packages/contracts/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* Invariant-adjacent: an unhandled rejection in a wallet is a silent
         failure, and silent failures are how funds go missing unnoticed. */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /* CLAUDE.md conventions: no `any`, no non-null assertions on external
         data. Both defeat the Zod boundary they would otherwise sit behind. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      /* No empty catch blocks. If a failure is genuinely unreachable, assert
         loudly instead of swallowing it. */
      'no-empty': ['error', { allowEmptyCatch: false }],

      /* Leading underscore marks a deliberately unused binding — a parameter
         kept to document a signature, or a discarded destructured field. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    /* core/ purity.
       WHY: business logic must be unit-testable with no rendering environment,
       so that policy evaluation, transaction construction, and factor
       orchestration can be reviewed and fuzzed in isolation. A single React
       import here starts the slide toward policy logic living in components,
       which is how client-side "enforcement" gets written by accident.
       See ARCHITECTURE.md §8. */
    files: ['apps/*/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-native', 'react-native/*', 'expo', 'expo-*', '@react-navigation/*'],
              message:
                'core/ must stay free of UI dependencies so it is testable without a renderer (ARCHITECTURE.md §8). Put this in ui/ instead.',
            },
          ],
        },
      ],

      /* Invariant 6: never log key material, proofs, or email content.
         The reliable way to keep secrets out of logs is to keep logging out of
         the modules that touch secrets. Surface failures by throwing typed
         errors and let the UI layer decide what is safe to display. */
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    /* Config files are plain JS and outside the typed project graph. */
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
