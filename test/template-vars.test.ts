import { describe, expect, it } from 'vitest';
import { substituteVars } from '../src/template-vars';

describe('substituteVars', () => {
  it('substitutes a known variable', () => {
    expect(substituteVars('Hello %recipient.name%!', { name: 'Alice' })).toBe(
      'Hello Alice!',
    );
  });

  it('substitutes several distinct variables in one string', () => {
    expect(
      substituteVars('To %recipient.first% %recipient.last%', {
        first: 'Ada',
        last: 'Lovelace',
      }),
    ).toBe('To Ada Lovelace');
  });

  it('substitutes every occurrence of a repeated variable', () => {
    expect(
      substituteVars('%recipient.name% and %recipient.name%', { name: 'Bob' }),
    ).toBe('Bob and Bob');
  });

  it('leaves an unknown variable verbatim', () => {
    expect(substituteVars('Hi %recipient.missing%', { name: 'Alice' })).toBe(
      'Hi %recipient.missing%',
    );
  });

  it('leaves every placeholder verbatim when the var map is empty', () => {
    expect(substituteVars('Hello %recipient.name%', {})).toBe(
      'Hello %recipient.name%',
    );
  });

  it('returns a string with no placeholders unchanged', () => {
    expect(substituteVars('plain text', { name: 'Alice' })).toBe('plain text');
  });

  it('returns the empty string unchanged', () => {
    expect(substituteVars('', { name: 'Alice' })).toBe('');
  });

  it('returns the string unchanged when vars is null', () => {
    expect(substituteVars('Hello %recipient.name%', null)).toBe(
      'Hello %recipient.name%',
    );
  });

  it('returns the string unchanged when vars is undefined', () => {
    expect(substituteVars('Hello %recipient.name%', undefined)).toBe(
      'Hello %recipient.name%',
    );
  });

  it('substitutes an empty-string value', () => {
    expect(substituteVars('Hi %recipient.name%!', { name: '' })).toBe('Hi !');
  });

  it('treats regex replacement patterns in a value as literal text', () => {
    expect(substituteVars('Hi %recipient.name%', { name: "$& $1 $` $' $$" })).toBe(
      "Hi $& $1 $` $' $$",
    );
  });

  it('substitutes inside an unsubscribe URL', () => {
    expect(
      substituteVars('<https://example.com/unsubscribe?uuid=%recipient.uuid%>', {
        uuid: 'abc-123',
      }),
    ).toBe('<https://example.com/unsubscribe?uuid=abc-123>');
  });

  it('does not carry regex lastIndex state between calls', () => {
    const template = '%recipient.a% %recipient.a%';
    const vars = { a: 'x' };
    expect(substituteVars(template, vars)).toBe('x x');
    expect(substituteVars(template, vars)).toBe('x x');
  });

  it('reproduces every captured template-vars case', async () => {
    const cases = (
      await import('./golden/captured/template-vars.json')
    ).default as Record<
      string,
      { input: { str: string; vars: Record<string, string> | null }; output: string }
    >;

    expect(Object.keys(cases).length).toBeGreaterThan(0);
    for (const [name, { input, output }] of Object.entries(cases)) {
      expect(substituteVars(input.str, input.vars), name).toBe(output);
    }
  });
});
