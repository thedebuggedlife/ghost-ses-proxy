import Busboy from 'busboy';
import type { Request } from 'express';

export type FormFields = Record<string, string | string[]>;

/** Fields Ghost repeats; every other field keeps last-write-wins semantics. */
export const ARRAY_FIELDS: ReadonlySet<string> = new Set(['to', 'o:tag']);

export function parseFormData(req: Request): Promise<FormFields> {
  return new Promise<FormFields>((resolve, reject) => {
    const fields: FormFields = {};
    const arrayFields: Record<string, string[]> = {};

    let busboy;
    try {
      busboy = Busboy({ headers: req.headers });
    } catch (e) {
      reject(new Error('Invalid multipart form-data: ' + (e as Error).message));
      return;
    }

    busboy.on('field', (name: string, value: string) => {
      if (ARRAY_FIELDS.has(name)) {
        const existing = arrayFields[name];
        if (existing) {
          existing.push(value);
        } else {
          arrayFields[name] = [value];
        }
      } else {
        fields[name] = value;
      }
    });

    busboy.on('finish', () => {
      for (const [name, values] of Object.entries(arrayFields)) {
        fields[name] = values;
      }
      resolve(fields);
    });

    busboy.on('error', (err: unknown) => {
      reject(err as Error);
    });

    req.pipe(busboy);
  });
}
