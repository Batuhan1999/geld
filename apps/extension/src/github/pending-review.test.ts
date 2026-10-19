// @vitest-environment happy-dom
import { githubMarkup, parsePendingComments, pendingCountOnPage } from './pending-review';

/** A `page_data/thread_previews` answer as GitHub gave it on brandonmcconnell/geld#68 (Oct 2026), trimmed. */
const THREAD = {
  id: '2921644721',
  isOutdated: false,
  path: 'packages/crf/schema/crf-v0.schema.json',
  subject: {
    diffLines: [
      { html: '@@ -0,0 +1,630 @@', left: null, right: 0, text: '@@ -0,0 +1,630 @@', type: 'HUNK' },
      { html: '{', left: null, right: 1, text: '+{', type: 'ADDITION' },
      { html: '  <span class="pl-ent">&quot;$schema&quot;</span>', left: null, right: 2, text: '+  "$schema"', type: 'ADDITION' },
      { html: '  <span class="pl-ent">&quot;$id&quot;</span>', left: null, right: 3, text: '+  "$id"', type: 'ADDITION' },
    ],
    endLine: 3,
  },
  line: 3,
  commentsData: {
    comments: [
      {
        id: 'PRRC_kwDOUOpwns8AAAABAX0R8w',
        databaseId: 4319941107,
        body: 'Geld test: pending comment, to be discarded',
        bodyHTML: '<p dir="auto">Geld test: pending comment, to be discarded</p>',
        currentDiffResourcePath: '/brandonmcconnell/geld/pull/68/files#r4319941107',
        url: 'https://github.com/brandonmcconnell/geld/pull/68#discussion_r4319941107',
        state: 'pending',
        viewerDidAuthor: true,
        publishedAt: null,
      },
    ],
  },
};

describe('parsePendingComments', () => {
  it('reads the reader’s pending comments with their file, line and diff', () => {
    expect(parsePendingComments([THREAD])).toEqual([
      {
        id: 'PRRC_kwDOUOpwns8AAAABAX0R8w',
        path: 'packages/crf/schema/crf-v0.schema.json',
        line: 3,
        outdated: false,
        diffLines: [
          { type: 'hunk', left: null, right: 0, html: '@@ -0,0 +1,630 @@' },
          { type: 'addition', left: null, right: 1, html: '{' },
          { type: 'addition', left: null, right: 2, html: '  <span class="pl-ent">&quot;$schema&quot;</span>' },
          { type: 'addition', left: null, right: 3, html: '  <span class="pl-ent">&quot;$id&quot;</span>' },
        ],
        bodyHtml: '<p dir="auto">Geld test: pending comment, to be discarded</p>',
        href: '/brandonmcconnell/geld/pull/68/files#r4319941107',
      },
    ]);
  });

  it('skips published comments and other people’s, and keeps the hunk over the last four lines', () => {
    const published = { ...THREAD.commentsData.comments[0], state: 'submitted' };
    const theirs = { ...THREAD.commentsData.comments[0], viewerDidAuthor: false };
    expect(parsePendingComments([{ ...THREAD, commentsData: { comments: [published, theirs] } }])).toEqual([]);
    const long = Array.from({ length: 8 }, (_, index) => ({ html: `line ${index + 1}`, left: index + 1, right: index + 1, type: 'CONTEXT' }));
    const parsed = parsePendingComments([{ ...THREAD, subject: { diffLines: [{ html: '@@ -1,8 +1,8 @@', left: null, right: null, type: 'HUNK' }, ...long] } }]);
    expect(parsed[0]?.diffLines.map((line) => line.html)).toEqual(['@@ -1,8 +1,8 @@', 'line 5', 'line 6', 'line 7', 'line 8']);
    expect(parsePendingComments({ error: 'Not Found' })).toEqual([]);
  });
});

describe('pendingCountOnPage', () => {
  it('reads the count from GitHub’s own Files changed button', () => {
    document.body.innerHTML = '<button class="ReviewMenuButton__x"><span>Submit review</span><span data-component="ButtonCounter">2</span></button>';
    expect(pendingCountOnPage()).toBe(2);
    document.body.innerHTML = '';
    expect(pendingCountOnPage()).toBeNull();
  });
});

describe('githubMarkup', () => {
  it('keeps GitHub’s rendering and drops what could run', () => {
    const host = document.createElement('div');
    host.append(githubMarkup('<p onclick="x()">Hi <code>a</code> <a href="javascript:alert(1)">x</a><script>bad()</script></p><span class="pl-ent">"$id"</span>'));
    expect(host.innerHTML).toBe('<p>Hi <code>a</code> <a>x</a></p><span class="pl-ent">"$id"</span>');
  });
});
