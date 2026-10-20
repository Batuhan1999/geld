// @vitest-environment happy-dom
import type { HeaderStatGroup } from './header-stats';
import { applyQuickReview, canSubmit, isInstantClick, pullPathOf, removeQuickReview, reviewErrorText, segmentHint, submitReviewRequest } from './quick-review';

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

describe('isInstantClick', () => {
  it('sends Approve or Request changes at once on ⌘-click on a Mac and Ctrl-click elsewhere, never Comment', () => {
    expect(isInstantClick('approve', { metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isInstantClick('request changes', { metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isInstantClick('approve', { metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isInstantClick('approve', { metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isInstantClick('approve', { metaKey: false, ctrlKey: false }, true)).toBe(false);
    expect(isInstantClick('comment', { metaKey: true, ctrlKey: true }, true)).toBe(false);
  });
});

describe('segmentHint', () => {
  it('names the verdict and the shortcut, or GitHub’s reason it is closed to the author', () => {
    expect(segmentHint('approve', false, '⌘')).toBe('Approve · ⌘-click to approve without a comment');
    expect(segmentHint('request changes', false, 'Ctrl')).toBe('Request changes · Ctrl-click to request changes without a comment');
    expect(segmentHint('comment', false, '⌘')).toBe('Comment');
    expect(segmentHint('approve', true, '⌘')).toBe("Pull request authors can't approve their own pull requests.");
    expect(segmentHint('comment', true, '⌘')).toBe('Comment');
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
  const mount = (): void => applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
  const segment = (event: string): HTMLButtonElement => {
    const button = document.querySelector(`.geld-quick-review__segment[data-event="${event}"]`);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`no ${event} segment`);
    return button;
  };
  const instant = { metaKey: true, ctrlKey: true, bubbles: true };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const chosen = (): string | undefined => document.querySelector<HTMLInputElement>('.geld-quick-review__panel input[type="radio"]:checked')?.value;

  it('is one group of three segments, ✓ ✗ 💬, named and explained', () => {
    mount();
    const group = document.querySelector('.geld-quick-review__group');
    expect(group?.getAttribute('role')).toBe('group');
    expect([...(group?.children ?? [])].map((child) => child.getAttribute('aria-label'))).toEqual(['Approve', 'Request changes', 'Comment']);
    expect([...(group?.children ?? [])].every((child) => child.classList.contains('BtnGroup-item'))).toBe(true);
    // The page here defines no `tool-tip`, so the words are each segment's title.
    expect(segment('approve').title).toMatch(/^Approve · (⌘|Ctrl)-click to approve without a comment$/);
    expect(segment('comment').title).toBe('Comment');
    expect(document.querySelector('.geld-quick-review__panel')).toBeNull();
  });

  it('opens the comment box with the verdict chosen on a click, as the confirmation', () => {
    mount();
    segment('approve').click();
    expect(document.querySelector('.geld-quick-review__panel .Overlay-title')?.textContent).toBe('Finish your review');
    expect(chosen()).toBe('approve');
    expect(segment('approve').getAttribute('aria-expanded')).toBe('true');
    // Approving needs no words, so the box's Submit is the confirmation.
    const submit = [...document.querySelectorAll<HTMLButtonElement>('.geld-quick-review__panel button')].find((button) => button.textContent === 'Submit review');
    expect(submit?.disabled).toBe(false);
    segment('request changes').click();
    expect(chosen()).toBe('request changes');
    expect(segment('approve').getAttribute('aria-expanded')).toBe('false');
    // The same segment again closes it.
    segment('request changes').click();
    expect(document.querySelector('.geld-quick-review__panel')).toBeNull();
  });

  it('opens the box from 💬 even with the instant key held', () => {
    mount();
    segment('comment').dispatchEvent(new MouseEvent('click', instant));
    expect(chosen()).toBe('comment');
  });

  it('approves at once on the instant click, without the box', async () => {
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/submit_review')) {
        sent.push({ url, body: String(init?.body) });
        return new Response('{}', { status: 200 });
      }
      return new Response('{"error":"Not Found"}', { status: 404 });
    }));
    mount();
    segment('approve').dispatchEvent(new MouseEvent('click', instant));
    await settle();
    await settle();
    expect(sent).toEqual([{ url: '/acme/widgets/pull/7/page_data/submit_review', body: JSON.stringify({ body: '', event: 'approve', headSha: SHA }) }]);
    expect(document.querySelector('.geld-quick-review__panel')).toBeNull();
    expect(document.querySelector('.geld-quick-review__status')?.textContent).toBe('Approved');
  });

  it('asks for words with GitHub’s reason when it refuses an instant verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/submit_review') ? new Response('{"error":"Review body is required"}', { status: 422 }) : new Response('{}', { status: 404 }),
    ));
    mount();
    segment('request changes').dispatchEvent(new MouseEvent('click', instant));
    await settle();
    await settle();
    expect(chosen()).toBe('request changes');
    expect(document.querySelector('.geld-quick-review__error')?.textContent).toBe('GitHub could not submit the review: Review body is required');
    expect(document.querySelector('.geld-quick-review__status')?.textContent).toBe('');
  });

  it('shows the author ✓ and ✗ disabled, with GitHub’s reason, and does nothing on them', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response('{}', { status: 404 });
    }));
    document.head.innerHTML = '<meta name="user-login" content="bob">';
    mount();
    expect(segment('approve').getAttribute('aria-disabled')).toBe('true');
    expect(segment('request changes').getAttribute('aria-disabled')).toBe('true');
    expect(segment('comment').hasAttribute('aria-disabled')).toBe(false);
    expect(segment('approve').title).toBe("Pull request authors can't approve their own pull requests.");
    expect(segment('request changes').title).toBe("Pull request authors can't request changes on their own pull requests.");
    segment('approve').click();
    segment('request changes').dispatchEvent(new MouseEvent('click', instant));
    await settle();
    expect(document.querySelector('.geld-quick-review__panel')).toBeNull();
    expect(sent.some((url) => url.endsWith('/submit_review'))).toBe(false);
    // The comment box keeps them listed and disabled too.
    segment('comment').click();
    const radios = [...document.querySelectorAll<HTMLInputElement>('.geld-quick-review__panel input[type="radio"]')];
    expect(radios.map((radio) => radio.disabled)).toEqual([false, true, true]);
  });

  it('counts the pending comments, lists them and discards the review as GitHub does', async () => {
    const pending = {
      id: '1',
      path: 'src/a.ts',
      line: 3,
      isOutdated: false,
      subject: { diffLines: [{ html: '@@ -1 +1 @@', left: null, right: null, type: 'HUNK' }, { html: 'const a = 1;', left: null, right: 3, type: 'ADDITION' }] },
      commentsData: { comments: [{ id: 'c1', state: 'pending', viewerDidAuthor: true, body: 'Rename `a` to something clearer. It reads as a typo.', currentDiffResourcePath: '/acme/widgets/pull/7/files#r1' }] },
    };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/thread_previews')) return new Response(JSON.stringify([pending]), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    const page = { kind: 'pull-conversation' as const, diffUrl: null, stateKey: '/acme/widgets/pull/7' };
    applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
    await new Promise((resolve) => setTimeout(resolve, 0));
    applyQuickReview(true, { page, groups: [groupAt(counts())], headSha: () => SHA });
    const button = document.querySelector<HTMLButtonElement>('.geld-quick-review__segment[data-event="comment"]');
    expect(button?.querySelector('.geld-quick-review__count')?.textContent).toBe('1');
    expect(button?.getAttribute('aria-label')).toBe('Comment, 1 pending comment');
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const box = document.querySelector('.geld-quick-review__panel');
    expect(box?.querySelector('.geld-quick-review__pending-toggle')?.textContent).toBe('Pending comments1');
    // One line per comment: its first sentence (inline code kept) and where it is, leading there on Files changed.
    const row = box?.querySelector('.geld-quick-review__pending-row');
    expect(row?.getAttribute('href')).toBe('/acme/widgets/pull/7/files#r1');
    expect(row?.querySelector('.geld-quick-review__pending-text')?.textContent).toBe('Rename a to something clearer.');
    expect(row?.querySelector('.geld-quick-review__pending-text code')?.textContent).toBe('a');
    expect(row?.querySelector('.geld-quick-review__pending-where')?.textContent).toBe('a.ts:3');
    expect(row?.getAttribute('title')).toBe('src/a.ts, line 3');
    // Pending comments go with the review, so a comment needs no words of its own.
    const submit = [...(box?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent === 'Submit review');
    expect(submit?.disabled).toBe(false);
    const discard = [...(box?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent === 'Discard review');
    expect(discard?.hidden).toBe(false);
    vi.stubGlobal('confirm', vi.fn(() => true));
    discard?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('DELETE /acme/widgets/pull/7/page_data/abandon_review');
    expect(button?.querySelector<HTMLElement>('.geld-quick-review__count')?.hidden).toBe(true);
  });

  it('reads the pull request path', () => {
    expect(pullPathOf('/acme/widgets/pull/7/changes')).toBe('/acme/widgets/pull/7');
    expect(pullPathOf('/acme/widgets/issues/7')).toBeNull();
  });
});
