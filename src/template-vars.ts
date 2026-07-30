export type RecipientVars = Record<string, string>;

/** Replaces `%recipient.name%` placeholders; unmatched placeholders are left verbatim. */
export function substituteVars(
  str: string,
  vars: RecipientVars | null | undefined,
): string {
  if (!str || !vars) return str;
  return str.replace(/%recipient\.([^%]+)%/g, (match: string, varName: string) => {
    const value = vars[varName];
    return value !== undefined ? value : match;
  });
}
