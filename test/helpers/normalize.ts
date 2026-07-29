import { createRequire } from 'node:module';

/**
 * One normalizer implementation only (plan Design Decision P9): `scripts/normalize.cjs`
 * is what the capture harness applied before writing every fixture, so the contract
 * test must apply the same code — not a copy of it — to the values it computes.
 */
const { normalize, normalizeJson } = createRequire(__filename)(
  '../../scripts/normalize.cjs',
) as {
  normalize: (s: string) => string;
  normalizeJson: (v: unknown) => unknown;
};

export { normalize };

export function normalizeValue<T>(value: unknown): T {
  return normalizeJson(value) as T;
}
