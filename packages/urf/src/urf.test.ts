import { readFileSync } from 'node:fs';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  EXAMPLE_FINDING,
  EXAMPLE_REFUSAL,
  EXAMPLE_STATUS,
  EXAMPLE_SUMMARY,
  FIXTURES,
  UrfBlock,
  checkConformance,
  encodeBlock,
  extractBlocks,
  parseBlock,
  readBlock,
  urfJsonSchemaText,
} from './index';

const summary = UrfBlock.parse(EXAMPLE_SUMMARY);

describe('schema', () => {
  it('conforms to its own fixtures', async () => {
    expect(await checkConformance(UrfBlock)).toEqual([]);
  });

  it('drops fields it does not know rather than rejecting them', () => {
    const parsed = UrfBlock.parse({ ...EXAMPLE_STATUS, vendor: { anything: true } });
    expect(parsed).not.toHaveProperty('vendor');
  });

  it('shares the finding shape between a summary and a thread comment', () => {
    const fromSummary = summary.kind === 'summary' ? summary.result?.findings?.[0] : undefined;
    const fromThread = UrfBlock.parse(EXAMPLE_FINDING);
    expect(fromThread.kind === 'finding' ? fromThread.finding.id : undefined).toBe(fromSummary?.id);
  });
});

describe('carrier', () => {
  it('round-trips through the HTML comment, including a title holding -->', () => {
    const block = UrfBlock.parse({
      ...EXAMPLE_FINDING,
      finding: { ...EXAMPLE_FINDING.finding, title: 'Closes early --> <script>' },
    });
    const comment = encodeBlock(block);
    expect(comment.indexOf('-->')).toBe(comment.length - 3);
    expect(comment.startsWith('<!-- urf:v0 {')).toBe(true);
    expect(parseBlock(`Some review prose.\n\n${comment}\n`)).toEqual(block);
  });

  it('takes the last block in a comment', () => {
    const body = `${encodeBlock(UrfBlock.parse(EXAMPLE_STATUS))}\n…\n${encodeBlock(summary)}`;
    expect(parseBlock(body)?.kind).toBe('summary');
  });

  it('makes no claim for malformed or invalid blocks', () => {
    expect(extractBlocks('<!-- urf:v0 {"schema": nope} -->')).toEqual([]);
    expect(parseBlock('<!-- urf:v0 {"schema":"urf/v0","kind":"reply"} -->')).toBeUndefined();
    expect(parseBlock('No block here.')).toBeUndefined();
  });

  it('leaves other bots’ markers alone and reads blocks of other versions without validating them', () => {
    const body = [
      '<!-- codex-review-state:v1 {"code_review":{"status":"completed"}} -->',
      '<!-- urf:v1 {"schema":"urf/v1","kind":"future"} -->',
    ].join('\n');
    expect(extractBlocks(body)).toEqual([{ version: 'v1', value: { schema: 'urf/v1', kind: 'future' } }]);
    expect(parseBlock(body)).toBeUndefined();
  });

  it('reads through any Standard Schema, not only Zod', async () => {
    const refusalsOnly: StandardSchemaV1<unknown, { kind: 'refusal'; code: string }> = {
      '~standard': {
        version: 1,
        vendor: 'hand-written',
        validate: (value) => {
          const parsed = UrfBlock.safeParse(value);
          if (parsed.success && parsed.data.kind === 'refusal') {
            return { value: { kind: 'refusal', code: parsed.data.refusal.code } };
          }
          return { issues: [{ message: 'not a refusal' }] };
        },
      },
    };
    expect(await readBlock(encodeBlock(UrfBlock.parse(EXAMPLE_REFUSAL)), refusalsOnly)).toEqual({ kind: 'refusal', code: 'quota' });
    expect(await readBlock(encodeBlock(summary), refusalsOnly)).toBeUndefined();
    expect(await checkConformance(refusalsOnly)).not.toEqual([]);
  });
});

describe('JSON Schema', () => {
  it('is committed and current (run `pnpm --filter @geld/urf schema` after changing the schema)', () => {
    const committed = readFileSync(new URL('../schema/urf-v0.schema.json', import.meta.url), 'utf8');
    expect(committed).toBe(urfJsonSchemaText());
  });

  it('keeps objects open, as readers ignore unknown fields', () => {
    expect(urfJsonSchemaText()).not.toContain('"additionalProperties": false');
  });

  it('has a fixture for every kind', () => {
    const kinds = new Set(FIXTURES.filter((f) => f.valid).map((f) => UrfBlock.parse(f.value).kind));
    expect([...kinds].sort()).toEqual(['finding', 'refusal', 'reply', 'status', 'summary']);
  });
});
