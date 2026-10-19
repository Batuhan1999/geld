// @vitest-environment happy-dom
import type { HeaderStatGroup } from './header-stats';
import { applyQuickReview, canSubmit, pullPathOf, removeQuickReview, reviewErrorText, submitReviewRequest } from './quick-review';

const SHA = 'a'.repeat(40);

function groupAt(host: HTMLElement): HeaderStatGroup {
  return { host, additions: null, deletions: null, srOnly: null, fileCounts: [], original: null, sentence: false };
}

describe('submitReviewRequest', () => {
  it('sends what GitHub’s review dialog sends', () => {
    const { url, init } = submitReviewRequest('/acme/widgets/pull/7', { body: 'Looks good', event: 'request changes', headSha: SHA }, 'v2:nonce');
    expect(url).toBe('/acme/widgets/pull/7/page_data/submit_review');
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ 'GitHub-Verified-Fetch': 'true', 'X-Fetch-Nonce': 'v2:nonce', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ body: 'Looks good', event: 'request changes', headSha: SHA });
    expect(submitReviewRequest('/acme/widgets/pull/7', { body: '', event: 'approve', headSha: SHA }, '').init.headers).not.toHaveProperty('X-Fetch-Nonce');
  });
});

describe('canSubmit', () => {
  it('needs words for a comment or a change request, unless pending comments go with it', () => {
    expect(canSubmit('approve', '', false)).toBe(true);
    expect(canSubmit('comment', '  ', false)).toBe(false);
    expect(canSubmit('comment', 'Nice', false)).toBe(true);
    expect(canSubmit('request changes', '', false)).toBe(false);
    expect(canSubmit('request changes', '', true)).toBe(true);
  });
});

describe('reviewErrorText', () => {
  it('says what GitHub said, or the status', () => {
    expect(reviewErrorText(422, { error: 'Review cannot be empty' })).toBe('GitHub could not submit the review: Review cannot be empty');
    expect(reviewErrorText(422, { errors: ['One.', { message: 'Two.' }] })).toBe('GitHub could not submit the review: One. Two.');
    expect(reviewErrorText(500, null)).toBe('GitHub could not submit the review (HTTP 500).');
  });
});

describe('the tab bar button', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Not Found"}', { status: 404 })));
    document.head.innerHTML = '<meta name="user-login" content="alice">';
    document.body.innerHTML = `
      <div data-component="PageHeader">
        <a class="text-bold" href="/bob">bob</a>
        <div class="rightContentWrapper"><div class="counts">+3 −1</div></div>
      </div>
      <div class="toolbar"><button class="ReviewMenuButton__x">Submit review</button></div>`;
    window.history.replaceState(null, '', '/acme/widgets/pull/7');
  });

  afterEach(() => {
    removeQuickReview();
    vi.unstubAllGlobals();
  });

  const counts = (): HTMLElement => {
    const element = document.querySelector('.counts');
    if (!(element instanceof HTMLElement)) throw new Error('fixture');
    return element;
  };

  it('sits left of the line counts on every pull request tab, once', () => {
    const page = { kind: 'pull-conversation' as const, diffUrl: null, stateKey: '/acme/widgets/pull/7' };
    applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
    applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
    const buttons = document.querySelectorAll('.geld-quick-review');
    expect(buttons).toHaveLength(1);
    expect(counts().previousElementSibling).toBe(buttons[0]);
    expect(document.documentElement.hasAttribute('data-geld-quick-review')).toBe(true);
    // Off, or on a page that is not a pull request, it goes and GitHub's own button is back.
    applyQuickReview(false, { page, groups: [groupAt(counts())], headSha: () => SHA });
    expect(document.querySelector('.geld-quick-review')).toBeNull();
    expect(document.documentElement.hasAttribute('data-geld-quick-review')).toBe(false);
  });

  it('is not shown signed out', () => {
    document.head.innerHTML = '';
    applyQuickReview(true, { page: { kind: 'pull-files', diffUrl: null, stateKey: '/acme/widgets/pull/7' }, groups: [groupAt(counts())], headSha: () => SHA });
    expect(document.querySelector('.geld-quick-review')).toBeNull();
  });

  it('opens GitHub’s choices, with approving and requesting changes closed to the author', () => {
    const page = { kind: 'pull-conversation' as const, diffUrl: null, stateKey: '/acme/widgets/pull/7' };
    applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
    document.querySelector<HTMLButtonElement>('.geld-quick-review')?.click();
    const panel = document.querySelector('.geld-quick-review__panel');
    expect(panel?.querySelector('.Overlay-title')?.textContent).toBe('Finish your review');
    const radios = [...(panel?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
    expect(radios.map((radio) => [radio.value, radio.disabled])).toEqual([['comment', false], ['approve', false], ['request changes', false]]);
    // Nothing to send yet: a comment needs words.
    const submit = [...(panel?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Submit review');
    expect(submit?.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('.geld-quick-review')?.click();
    expect(document.querySelector('.geld-quick-review__panel')).toBeNull();

    document.head.innerHTML = '<meta name="user-login" content="bob">';
    document.querySelector<HTMLButtonElement>('.geld-quick-review')?.click();
    const authorRadios = [...document.querySelectorAll<HTMLInputElement>('.geld-quick-review__panel input[type="radio"]')];
    expect(authorRadios.map((radio) => radio.disabled)).toEqual([false, true, true]);
    expect(document.querySelector('.geld-quick-review__panel')?.textContent).toContain("Pull request authors can't approve their own pull requests.");
  });

  it('reads the pull request path', () => {
    expect(pullPathOf('/acme/widgets/pull/7/changes')).toBe('/acme/widgets/pull/7');
    expect(pullPathOf('/acme/widgets/issues/7')).toBeNull();
  });
});
