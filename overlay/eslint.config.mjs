// ESLint flat config for the Board's TypeScript.
//
// Until now `tsc --strict` (plus noUnusedLocals / noUnusedParameters) was the ONLY thing
// that ever read this code — there was no linter at all, which is part of how board.ts
// reached 5,400 lines unremarked.
//
// The rule set is chosen to PASS on today's code, not to be maximal. A linter that lands
// with 400 pre-existing errors gets `--no-verify`'d within a week and then teaches nothing;
// one that is green from day one turns every new violation into a real signal. Tighten it by
// promoting rules deliberately, with the fixes in the same commit.
//
//   npm run lint        check
//   npm run lint:fix    check + autofix
//   npm run format      Prettier over src/ + scripts/
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Never lint build output, deps, or the vendored bundles.
    ignores: ["dist/", "dist-demo/", "node_modules/", "src-tauri/target/", "demo.html"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware linting, and only for `src/` — this is where the rules that actually catch
    // bugs live: a floating promise in an IPC-heavy frontend is a silently swallowed
    // failure, which is the class this codebase is most exposed to.
    //
    // Scoped to src/ because tsconfig.json's `include` is `["src"]`, so the project service
    // genuinely has no program for `scripts/`. Those run standalone under node's
    // type-stripping rather than as part of the app build, so widening the tsconfig just to
    // lint them would change what the app compiles. They get the untyped rules below.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // THE high-value rule for this app: every Tauri `invoke` returns a promise, and one
      // that is neither awaited nor explicitly `void`ed fails with no trace at all.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // Passing an async function as an event-listener callback is idiomatic here and
        // harmless (the listener genuinely does not want the result), so only flag the
        // conditional case, where a promise is truthy and the check is always wrong.
        { checksVoidReturn: false },
      ],
      // `unknown` is already the house style at the boundaries; keep `any` from creeping in.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Rules that hold everywhere, tuned to conventions this codebase already follows.
    rules: {
      // `no-undef` must be OFF in TypeScript — this is the one config note typescript-eslint
      // makes loudest. It has no idea about lib.dom / lib.es2020 or Node globals, so it
      // reports `console`, `process`, `ResizeObserver` and friends as undefined while the
      // type-checker knows all of them. Leaving it on produced 40 of the first 59 errors,
      // every one false. tsc is the authority on whether a name exists.
      "no-undef": "off",
      // tsconfig's noUnusedLocals/noUnusedParameters already cover this; ESLint's version
      // would only duplicate the error. Kept off so one violation isn't reported twice.
      "@typescript-eslint/no-unused-vars": "off",
      // A leading underscore is the existing convention for a deliberately-ignored binding.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Bare `==` against null is idiomatic and safe; everything else must be strict.
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Accidental re-assignment of an import or a caught error is always a bug.
      "no-import-assign": "error",
      "no-ex-assign": "error",
      // `console` IS the logging channel in a webview with no other transport, so the
      // blanket ban in the house rules does not apply — but keep debugger out.
      "no-debugger": "error",
    },
  },
  {
    // The hook scripts are deliberately CommonJS: they are spawned by a `sh` hook on a
    // user's machine with no build step, so `require` is the only import form available to
    // them. Flagging it would be flagging the architecture.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
