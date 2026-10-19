// @vitest-environment happy-dom
import type { HeaderStatGroup } from './header-stats';
import { applyQuickReview, canSubmit, menuRows, pullPathOf, removeQuickReview, reviewErrorText, submitReviewRequest } from './quick-review';

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

describe('menuRows', () => {
  it('gives Approve and Request changes a direct send and a comment button, Comment only the box', () => {
    expect(menuRows(false).map(({ event, direct, withComment, disabled }) => [event, direct, withComment, disabled])).toEqual([
      ['comment', false, false, false],
      ['approve', true, true, false],
      ['request changes', true, true, false],
    ]);
    expect(menuRows(true).map((row) => row.disabled)).toEqual([false, true, true]);
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

  const page = { kind: 'pull-conversation' as const, diffUrl: null, stateKey: '/acme/widgets/pull/7' };
  const openMenu = (): HTMLElement => {
    applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
    document.querySelector<HTMLButtonElement>('.geld-quick-review')?.click();
    const menu = document.querySelector('.geld-quick-review__panel--menu');
    if (!(menu instanceof HTMLElement)) throw new Error('no menu');
    return menu;
  };
  const row = (menu: HTMLElement, event: string): HTMLButtonElement => {
    const item = menu.querySelector(`.geld-quick-review__item[data-event="${event}"]`);
    if (!(item instanceof HTMLButtonElement)) throw new Error(`no ${event} row`);
    return item;
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('opens a menu of the three verdicts, Approve and Request changes with a comment button each', () => {
    const menu = openMenu();
    expect([...menu.querySelectorAll('.geld-quick-review__item-label')].map((label) => label.textContent)).toEqual(['Comment', 'Approve', 'Request changes']);
    expect([...menu.querySelectorAll('.geld-quick-review__with-comment')].map((button) => button.getAttribute('aria-label'))).toEqual(['Approve with a comment', 'Request changes with a comment']);
    expect([...menu.querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
    // Comment needs words: its row opens the comment box with Comment chosen.
    row(menu, 'comment').click();
    const box = document.querySelector('.geld-quick-review__panel:not(.geld-quick-review__panel--menu)');
    expect(box?.querySelector('.Overlay-title')?.textContent).toBe('Finish your review');
    expect(box?.querySelector<HTMLInputElement>('input[value="comment"]')?.checked).toBe(true);
    expect(document.querySelector('.geld-quick-review__panel--menu')).toBeNull();
    const submit = [...(box?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Submit review');
    expect(submit?.disabled).toBe(true);
  });

  it('opens the comment box with the verdict chosen from its comment button', () => {
    const menu = openMenu();
    menu.querySelectorAll<HTMLButtonElement>('.geld-quick-review__with-comment')[1]?.click();
    expect(document.querySelector<HTMLInputElement>('.geld-quick-review__panel input[value="request changes"]')?.checked).toBe(true);
  });

  it('approves at once from the Approve row', async () => {
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/submit_review')) {
        sent.push({ url, body: String(init?.body) });
        return new Response('{}', { status: 200 });
      }
      return new Response('{"error":"Not Found"}', { status: 404 });
    }));
    row(openMenu(), 'approve').click();
    await settle();
    await settle();
    expect(sent).toEqual([{ url: '/acme/widgets/pull/7/page_data/submit_review', body: JSON.stringify({ body: '', event: 'approve', headSha: SHA }) }]);
    expect(document.querySelector('.geld-quick-review__panel')).toBeNull();
    expect(document.querySelector('.geld-quick-review')?.textContent).toBe('Approved');
  });

  it('asks for words with GitHub’s reason when it refuses a verdict without them', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/submit_review') ? new Response('{"error":"Review body is required"}', { status: 422 }) : new Response('{}', { status: 404 }),
    ));
    row(openMenu(), 'request changes').click();
    await settle();
    await settle();
    const box = document.querySelector('.geld-quick-review__panel');
    expect(box?.querySelector<HTMLInputElement>('input[value="request changes"]')?.checked).toBe(true);
    expect(box?.querySelector('.geld-quick-review__error')?.textContent).toBe('GitHub could not submit the review: Review body is required');
    expect(document.querySelector('.geld-quick-review')?.textContent).toBe('Submit review');
  });

  it('shows the author what they cannot do, disabled, with GitHub’s reason', () => {
    document.head.innerHTML = '<meta name="user-login" content="bob">';
    const menu = openMenu();
    expect(row(menu, 'comment').disabled).toBe(false);
    expect(row(menu, 'approve').disabled).toBe(true);
    expect(row(menu, 'request changes').disabled).toBe(true);
    expect([...menu.querySelectorAll<HTMLButtonElement>('.geld-quick-review__with-comment')].every((button) => button.disabled)).toBe(true);
    expect(menu.textContent).toContain("Pull request authors can't approve their own pull requests.");
    expect(menu.textContent).toContain("Pull request authors can't request changes on their own pull requests.");
    // The comment box keeps them listed and disabled too.
    row(menu, 'comment').click();
    const radios = [...document.querySelectorAll<HTMLInputElement>('.geld-quick-review__panel input[type="radio"]')];
    expect(radios.map((radio) => radio.disabled)).toEqual([false, true, true]);
  });

  it('reads the pull request path', () => {
    expect(pullPathOf('/acme/widgets/pull/7/changes')).toBe('/acme/widgets/pull/7');
    expect(pullPathOf('/acme/widgets/issues/7')).toBeNull();
  });
});
