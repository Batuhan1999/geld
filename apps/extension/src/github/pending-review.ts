/**
 * The reader's pending review on a pull request: the comments left with
 * "Start a review", waiting to go out with it. GitHub's own dialog lists them
 * from the files view's store; on any tab the same threads come from
 * `page_data/thread_previews` (path, line, the diff lines above it, every
 * comment with its `state`), where a pending comment is `state: "pending"`
 * and `viewerDidAuthor`. `page_data/pending_review` answers 404 whether or
 * not one exists, so it says nothing (seen Oct 2026).
 */

export interface PendingDiffLine {
  readonly type: 'hunk' | 'addition' | 'deletion' | 'context';
  readonly left: number | null;
  readonly right: number | null;
  /** GitHub's highlighted markup for the line, without the +/- marker. */
  readonly html: string;
}

export interface PendingComment {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly outdated: boolean;
  /** The lines up to the commented one, as GitHub's dialog shows them (at most {@link DIFF_LINES} after the hunk header). */
  readonly diffLines: readonly PendingDiffLine[];
  readonly bodyHtml: string;
  /** Where the comment is in the diff. */
  readonly href: string | null;
}

const DIFF_LINES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diffLineOf(value: unknown): PendingDiffLine | null {
  if (!isRecord(value)) return null;
  const kind = stringOf(value.type)?.toLowerCase();
  const type = kind === 'hunk' || kind === 'addition' || kind === 'deletion' || kind === 'context' ? kind : null;
  if (type === null) return null;
  return { type, left: numberOf(value.left), right: numberOf(value.right), html: stringOf(value.html) ?? '' };
}

/** The last lines before (and at) the comment, with the hunk header they fall under kept on top. */
function shownLines(lines: readonly PendingDiffLine[]): readonly PendingDiffLine[] {
  const code = lines.flatMap((line, index) => (line.type === 'hunk' ? [] : [index]));
  const start = code.at(-DIFF_LINES) ?? code[0];
  if (start === undefined) return [];
  let hunk: PendingDiffLine | undefined;
  for (let index = start - 1; index >= 0 && hunk === undefined; index -= 1) {
    if (lines[index]?.type === 'hunk') hunk = lines[index];
  }
  const tail = lines.slice(start).filter((line) => line.type !== 'hunk');
  return hunk === undefined ? tail : [hunk, ...tail];
}

/** The viewer's pending comments in a `thread_previews` answer, in the order GitHub gives the threads. */
export function parsePendingComments(payload: unknown): readonly PendingComment[] {
  if (!Array.isArray(payload)) return [];
  const out: PendingComment[] = [];
  for (const thread of payload) {
    if (!isRecord(thread)) continue;
    const path = stringOf(thread.path);
    const commentsData = thread.commentsData;
    const comments = isRecord(commentsData) && Array.isArray(commentsData.comments) ? commentsData.comments : [];
    if (path === null) continue;
    const subject = isRecord(thread.subject) ? thread.subject : {};
    const lines = Array.isArray(subject.diffLines) ? subject.diffLines.map(diffLineOf).filter((line): line is PendingDiffLine => line !== null) : [];
    for (const comment of comments) {
      if (!isRecord(comment) || stringOf(comment.state) !== 'pending' || comment.viewerDidAuthor !== true) continue;
      out.push({
        id: stringOf(comment.id) ?? String(numberOf(comment.databaseId) ?? out.length),
        path,
        line: numberOf(thread.line) ?? numberOf(subject.endLine),
        outdated: thread.isOutdated === true,
        diffLines: shownLines(lines),
        bodyHtml: stringOf(comment.bodyHTML) ?? '',
        href: stringOf(comment.currentDiffResourcePath) ?? stringOf(comment.url),
      });
    }
  }
  return out;
}

function jsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', 'GitHub-Verified-Fetch': 'true', 'X-Requested-With': 'XMLHttpRequest' };
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="fetch-nonce"]')?.content ?? '';
  if (nonce !== '') headers['X-Fetch-Nonce'] = nonce;
  return headers;
}

/** The reader's pending comments on `/owner/repo/pull/N`; null when GitHub could not say. */
export async function fetchPendingComments(pullPath: string): Promise<readonly PendingComment[] | null> {
  try {
    const response = await fetch(`${pullPath}/page_data/thread_previews`, { credentials: 'same-origin', headers: jsonHeaders() });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return parsePendingComments(payload);
  } catch {
    return null;
  }
}

/** Discard the pending review and its comments, as GitHub's "Discard review" does. */
export async function discardPendingReview(pullPath: string): Promise<boolean> {
  try {
    const response = await fetch(`${pullPath}/page_data/abandon_review`, { method: 'DELETE', credentials: 'same-origin', headers: { ...jsonHeaders(), 'Content-Type': 'application/json' } });
    return response.ok;
  } catch {
    return false;
  }
}

/** The count GitHub's own (hidden) Files changed button shows, live while comments are added there. */
export function pendingCountOnPage(): number | null {
  const counter = document.querySelector('[class*="ReviewMenuButton"] [data-component="ButtonCounter"]');
  if (counter === null) return null;
  const count = Number.parseInt(counter.textContent?.trim() ?? '', 10);
  return Number.isFinite(count) ? count : null;
}

const DROPPED_ELEMENTS = 'script, style, iframe, object, embed, form, input, button, textarea, select, link, meta, base';

/**
 * GitHub's own rendered markup (a comment's body, a highlighted line) as
 * nodes to show, without anything that runs or submits: GitHub sanitizes it
 * for its page already, and this keeps that true wherever Geld puts it.
 */
export function githubMarkup(markup: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  for (const element of parsed.body.querySelectorAll(DROPPED_ELEMENTS)) element.remove();
  for (const element of parsed.body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attribute.value))) element.removeAttribute(attribute.name);
    }
  }
  const fragment = document.createDocumentFragment();
  fragment.append(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  return fragment;
}
