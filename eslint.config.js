/**
 * ESLint flat config.
 *
 * Deliberately the non-type-checked `recommended` set: `tsc --noEmit` is already
 * the type gate in CI and runs as its own step, so duplicating it inside the
 * linter would only make the lint step slower and its failures harder to read.
 * What lint adds here is the class of problem the compiler does not report --
 * unused bindings, accidental `any`, shadowed names, `==` vs `===`.
 *
 * The `clock-guard` block below is the determinism ratchet from the
 * determinism-sweep issue: `Date.now()`, `new Date()`, and `Math.random()` are
 * forbidden in `src/` except where an inline allowlist comment justifies the
 * use. The only current allowlist is `src/clock.ts`, which is the default clock
 * implementation and the one place allowed to read the wall clock. This is a
 * gate, not a habit: reintroducing `Date.now()` anywhere else in `src/` fails
 * `npm run lint`.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // TypeScript resolves identifiers itself; `no-undef` has no type
      // information and reports every Node global (process, Buffer, console)
      // as undefined in a typed codebase.
      "no-undef": "off",
      // `_`-prefixed parameters are intentional: the structural framework
      // adapters take arguments they must accept but do not all read.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // Determinism ratchet: no wall-clock or `bare randomness in `src/`.
  // The allowlist is the inline `eslint-disable-next-line no-restricted-globals`
  // comment in `src/clock.ts` (the default clock implementation). Reintroducing
  // `Date.now()`, `new Date()`, or `Math.random()` anywhere else in `src/` fails
  // `npm run lint`.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "Time reads must go through the injected Clock (see src/clock.ts). If this is the default clock implementation, add an inline `eslint-disable-next-line no-restricted-globals` comment justifying it.",
        },
        {
          name: "Math",
          message:
            "Math.random() is not collision-safe for ids and not deterministic for tests. Take an injected RNG instead.",
        },
      ],
    },
  },
);
