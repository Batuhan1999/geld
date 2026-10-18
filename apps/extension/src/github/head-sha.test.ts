// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { detectHeadSha } from './head-sha';
import { restoreAll, teleportInto } from './review/teleport';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('detectHeadSha', () => {
  const row = (sha: string, extra = ''): string => `<div class="TimelineItem"><div class="js-commits-list-item"><a href="/acme/widgets/pull/71/commits/${sha}">${sha.slice(0, 7)}</a>${extra}</div></div>`;

  it('reads the conversation tab from its last commit row, which a live push appends', () => {
    window.history.replaceState(null, '', '/acme/widgets/pull/71');
    document.body.innerHTML = `
      <div class="js-discussion">${row(A)}${row(B)}</div>
      <div class="js-stale-comparison" data-url="/acme/widgets/pull/71/partials/stale?end_commit_oid=${A}"></div>`;
    expect(detectHeadSha()).toBe(B);
    // The socket appends the pushed commit's row; the poller's attribute stays as loaded.
    document.querySelector('.js-discussion')?.insertAdjacentHTML('beforeend', row(C));
    expect(detectHeadSha()).toBe(C);
  });

  it('takes only commit rows for this pull request, never a link in a comment', () => {
    window.history.replaceState(null, '', '/acme/widgets/pull/71');
    // A comment after the last push linking an older commit (and one of another repository's pull request) is
    // not a push; nor is a bare link outside any commit row.
    document.body.innerHTML = `
      <div class="js-discussion">
        ${row(A)}${row(B)}
        <div class="TimelineItem"><div class="comment-body"><a href="https://github.com/acme/widgets/pull/71/commits/${A}">see</a><a href="/acme/gadgets/pull/9/commits/${C}">other</a></div></div>
        <div class="TimelineItem"><a href="/acme/widgets/pull/71/commits/${C}">loose</a></div>
      </div>`;
    expect(detectHeadSha()).toBe(B);
    // With no commit row at all the other hooks answer.
    document.body.innerHTML = `<div data-url="/acme/widgets/pull/71/partials/stale?end_commit_oid=${A}"></div>`;
    expect(detectHeadSha()).toBe(A);
  });

  it('orders commit rows by their home, not where a loan has moved them', () => {
    window.history.replaceState(null, '', '/acme/widgets/pull/71');
    document.body.innerHTML = `
      <div class="geld-review"><div class="slot"></div></div>
      <div class="js-discussion">${row(A)}${row(B)}</div>`;
    // The digest shows the newest row in a slot above the timeline; its place at home is still last.
    const newest = document.querySelectorAll('.js-discussion > .TimelineItem')[1];
    const slot = document.querySelector('.slot');
    if (!(newest instanceof HTMLElement) || !(slot instanceof HTMLElement)) throw new Error('fixture');
    teleportInto(slot, [newest]);
    expect(detectHeadSha()).toBe(B);
    restoreAll();
  });

  it('leaves the other pages to their own hooks', () => {
    window.history.replaceState(null, '', '/acme/widgets/pull/71/files');
    document.body.innerHTML = `
      <a href="/acme/widgets/pull/71/commits/${B}">b</a>
      <div data-url="/acme/widgets/pull/71/partials/stale?end_commit_oid=${A}"></div>`;
    expect(detectHeadSha()).toBe(A);
  });
});
