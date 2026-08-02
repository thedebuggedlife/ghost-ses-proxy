import type { Registry } from 'prom-client';

/**
 * Children of `name` keyed by `label`, with every value in `values` filled to 0 when the child
 * is absent — so an assertion reads identically before and after zero-initialisation.
 */
export async function normalisedChildren(
  register: Registry,
  name: string,
  label: string,
  values: readonly string[],
): Promise<Record<string, number>> {
  const json = await register.getMetricsAsJSON();
  const metric = json.find((entry) => entry.name === name);
  const children = ((metric as { values?: unknown } | undefined)?.values ??
    []) as { labels: Record<string, string | number>; value: number }[];
  const out: Record<string, number> = Object.fromEntries(
    values.map((value) => [value, 0]),
  );
  for (const child of children) {
    out[String(child.labels[label])] = child.value;
  }
  return out;
}
