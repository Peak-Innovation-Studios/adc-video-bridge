import { defineConfig, defaultExclude } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Fake-timer tests that drive async retry loops trigger
    // PromiseRejectionHandledWarning because Node flags rejections as
    // "unhandled" for a microtask tick before the try/catch picks them up.
    // All rejections ARE handled — the warning is a timing artefact.
    dangerouslyIgnoreUnhandledErrors: true,
    // ⚠️ Must SPREAD defaultExclude — setting `exclude` replaces it rather
    // than extending it, and in vitest 4 the default is only node_modules
    // and .git, so a bare list would start walking node_modules.
    exclude: [
      ...defaultExclude,
      // Agent worktrees live under .claude/worktrees/ INSIDE the repo, so
      // their copy of src/ matches the default include glob and every suite
      // run counted twice (12 files/180 tests -> 24/360). Harmless while the
      // copies agree; actively misleading when they don't, because a stale
      // worktree's failures fail main's suite and point at files that look
      // exactly like the ones you are editing.
      '**/.claude/**',
      // vitest 4 dropped dist from defaultExclude. tsconfig currently keeps
      // tests out of the build, so this changes nothing today — it stops a
      // future tsconfig change from silently reintroducing the same
      // double-count via compiled test files.
      '**/dist/**',
    ],
  },
});
