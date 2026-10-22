import type { StandardSchemaV1 } from '@standard-schema/spec';
import { CRF_VERSION, CrfBlock } from './schema';

export const MARKER_PREFIX = `crf:${CRF_VERSION}`;

// Each HTML comment whole, to its own `-->` (the JSON cannot contain one: writers escape `<` and `>`), so a block whose
// JSON is unfinished ends where its comment does and never runs on into the next block.
const BLOCK_PATTERN = /<!--\s*crf:(v\d+)\s+([\s\S]*?)\s*-->/g;

interface FoundBlock {
  readonly version: string;
  readonly json: string;
}

/** The Markdown with every fenced code block (``` or ~~~, CommonMark's rules) blanked out: an example there is not a claim. */
function outsideFences(markdown: string): string {
  let fence: { readonly char: string; readonly length: number } | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      // A fence may stand inside a list item or a quote (`- ```json`, `  ````, `> ````): their markers come first.
      const found = /^[\s>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[\s>]*(`{3,}|~{3,})(.*)$/.exec(line);
      const marker = found?.[1];
      const tail = found?.[2] ?? '';
      if (fence === null) {
        if (marker === undefined || (marker[0] === '`' && tail.includes('`'))) return line;
        fence = { char: marker[0] ?? '`', length: marker.length };
        return '';
      }
      if (marker !== undefined && marker[0] === fence.char && marker.length >= fence.length && tail.trim() === '') fence = null;
      return '';
    })
    .join('\n');
}

function findBlocks(markdown: string): FoundBlock[] {
  const found: FoundBlock[] = [];
  for (const match of outsideFences(markdown).matchAll(BLOCK_PATTERN)) {
    const [, version, json] = match;
    if (version !== undefined && json !== undefined) found.push({ version, json });
  }
  return found;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export interface RawBlock {
  readonly version: string;
  readonly value: unknown;
}

/** Every `<!-- crf:vN {…} -->` in a comment's raw Markdown, in order, JSON-parsed but not validated. Malformed JSON is skipped. */
export function extractBlocks(markdown: string): RawBlock[] {
  return findBlocks(markdown).flatMap(({ version, json }) => {
    const value = parseJson(json);
    return value === undefined ? [] : [{ version, value }];
  });
}

/**
 * The block as the HTML comment a bot appends to its comment, on a line of its own.
 * `<` and `>` become `\u003c` and `\u003e`: still the same JSON, and a `-->` inside a title cannot end the comment early.
 */
export function encodeBlock(block: CrfBlock): string {
  // Validated, but the writer's own object is what is written: parsing strips the fields a bot may add of its own.
  CrfBlock.parse(block);
  const json = JSON.stringify(block).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- ${MARKER_PREFIX} ${json} -->`;
}

/** The last block of this version, chosen before it is parsed: a malformed last block makes no claim rather than revive an earlier one. */
function lastOfThisVersion(markdown: string): unknown {
  const last = findBlocks(markdown)
    .filter((block) => block.version === CRF_VERSION)
    .at(-1);
  return last === undefined ? undefined : parseJson(last.json);
}

/** The comment's block, validated against this package's schema. The last block wins; an invalid one makes no claim. */
export function parseBlock(markdown: string): CrfBlock | undefined {
  const value = lastOfThisVersion(markdown);
  if (value === undefined) return undefined;
  const result = CrfBlock.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Same as `parseBlock`, validated by any Standard Schema: this package's, or one written in Valibot, ArkType or another library. */
export async function readBlock<S extends StandardSchemaV1>(
  markdown: string,
  schema: S,
): Promise<StandardSchemaV1.InferOutput<S> | undefined> {
  const value = lastOfThisVersion(markdown);
  if (value === undefined) return undefined;
  const result = await schema['~standard'].validate(value);
  return result.issues ? undefined : result.value;
}
