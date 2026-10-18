// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { detectHeadSha } from './head-sha';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('detectHeadSha', () => {
  it('reads the conversation tab from its last commit row, which a live push appends', () => {
    window.history.replaceState(null, '', '/acme/widgets/pull/71');
    document.body.innerHTML = `
      <div class="js-discussion">
        <div class="TimelineItem"><a href="/acme/widgets/pull/71/commits/${A}">a</a></div>
        <div class="TimelineItem"><a href="/acme/widgets/pull/71/commits/${B}">b</a></div>
      </div>
      <div class="js-stale-comparison" data-url="/acme/widgets/pull/71/partials/stale?end_commit_oid=${A}"></div>`;
    expect(detectHeadSha()).toBe(B);
    // The socket appends the pushed commit's row; the poller's attribute stays as loaded.
    document.querySelector('.js-discussion')?.insertAdjacentHTML('beforeend', `<div class="TimelineItem"><a href="/acme/widgets/pull/71/commits/${C}">c</a></div>`);
    expect(detectHeadSha()).toBe(C);
  });

  it('leaves the other pages to their own hooks', () => {
    window.history.replaceState(null, '', '/acme/widgets/pull/71/files');
    document.body.innerHTML = `
      <a href="/acme/widgets/pull/71/commits/${B}">b</a>
      <div data-url="/acme/widgets/pull/71/partials/stale?end_commit_oid=${A}"></div>`;
    expect(detectHeadSha()).toBe(A);
  });
});
