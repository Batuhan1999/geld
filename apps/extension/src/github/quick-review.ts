import { createElement, OWN_UI_ATTRIBUTE, svgFromString } from './dom';
import type { HeaderStatGroup } from './header-stats';
import { detectHeadSha } from './head-sha';
import type { PageInfo } from './page';
import type { PendingComment } from './pending-review';
import { discardPendingReview, fetchPendingComments, githubMarkup, pendingCountOnPage } from './pending-review';
import { ICON_CHECK, ICON_CHEVRON_DOWN, ICON_COMMENT, ICON_FILE_DIFF, ICON_TRIANGLE_DOWN, ICON_X } from './ui/icons';

/**
 * "Submit review" in the pull request's tab bar, left of the line counts, on
 * every tab. GitHub's own button exists only on the Files changed tab and is
 * React's, so this is Geld's: the same 28px primary button opening a menu of
 * the three verdicts (Comment opens the comment box; Approve and Request
 * changes send at once, or with words through the comment button beside
 * them), and the request GitHub's dialog sends (`PUT page_data/submit_review`,
 * verified Oct 2026), which needs nothing from that tab. While it is mounted
 * GitHub's button is hidden, so the action shows once.
 */

export type ReviewEvent = 'comment' | 'approve' | 'request changes';

export interface ReviewSubmission {
  readonly body: string;
  readonly event: ReviewEvent;
  readonly headSha: string;
}

export interface QuickReviewContext {
  readonly page: PageInfo;
  /** The page's header stat groups; the button goes before the tab bar's. */
  readonly groups: readonly HeaderStatGroup[];
  /** The head commit when the review is sent (it may move while the popover is open). */
  readonly headSha: () => string | null;
}

const BUTTON_CLASS = 'geld-quick-review';
const PANEL_CLASS = 'geld-quick-review__panel';
/** On `<html>` while the button is mounted; the stylesheet hides GitHub's own review button under it. */
const ATTR_ACTIVE = 'data-geld-quick-review';
/** On the box holding the button and the counts; the stylesheet centres both on the tabs there. */
const ATTR_HOST = 'data-geld-quick-review-host';
const SUBMITTED_MS = 3000;

interface EventInfo {
  readonly value: ReviewEvent;
  readonly label: string;
  readonly note: string;
  /** GitHub's reason the author cannot take this one, when they cannot. */
  readonly authorNote: string | null;
  /** The menu row's glyph, in the colour GitHub's timeline gives the verdict. */
  readonly icon: string;
  readonly tone: 'muted' | 'success' | 'danger';
  /** The button's words for a moment after it went through. */
  readonly done: string;
}

const EVENT_INFO: { readonly [E in ReviewEvent]: EventInfo } = {
  comment: { value: 'comment', label: 'Comment', note: 'Submit general feedback without explicit approval.', authorNote: null, icon: ICON_COMMENT, tone: 'muted', done: 'Review submitted' },
  approve: {
    value: 'approve',
    label: 'Approve',
    note: 'Submit feedback and approve merging these changes.',
    authorNote: "Pull request authors can't approve their own pull requests.",
    icon: ICON_CHECK,
    tone: 'success',
    done: 'Approved',
  },
  'request changes': {
    value: 'request changes',
    label: 'Request changes',
    note: 'Submit feedback suggesting changes.',
    authorNote: "Pull request authors can't request changes on their own pull requests.",
    icon: ICON_FILE_DIFF,
    tone: 'danger',
    done: 'Changes requested',
  },
};

const EVENTS: readonly EventInfo[] = [EVENT_INFO.comment, EVENT_INFO.approve, EVENT_INFO['request changes']];

/** What a menu row does, and what its comment button does (null: the row itself opens the comment box). */
export interface MenuRow {
  readonly event: ReviewEvent;
  readonly direct: boolean;
  readonly withComment: boolean;
  readonly disabled: boolean;
  /** GitHub's reason the verdict is closed to the reader, when it is. */
  readonly reason: string | null;
}

/**
 * The menu's rows: Comment always needs words, so its row opens the comment
 * box and has no comment button; Approve and Request changes send as they
 * are, or open the box through the comment button beside them. Titles
 * only, no notes: the menu stays small. What the author cannot do stays
 * listed, disabled, with GitHub's reason as its tooltip.
 */
export function menuRows(isAuthor: boolean): readonly MenuRow[] {
  return EVENTS.map(({ value, authorNote }) => {
    const disabled = isAuthor && authorNote !== null;
    return { event: value, direct: value !== 'comment', withComment: value !== 'comment', disabled, reason: disabled ? authorNote : null };
  });
}

/** `/owner/repo/pull/N` for a pull request page, else null. */
export function pullPathOf(pathname: string): string | null {
  return /^\/[^/]+\/[^/]+\/pull\/\d+/.exec(pathname)?.[0] ?? null;
}

/** What GitHub's review dialog sends, from the page's own origin and session. */
export function submitReviewRequest(pullPath: string, submission: ReviewSubmission, nonce: string): { readonly url: string; readonly init: RequestInit } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'GitHub-Verified-Fetch': 'true',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (nonce !== '') headers['X-Fetch-Nonce'] = nonce;
  return {
    url: `${pullPath}/page_data/submit_review`,
    init: { method: 'PUT', credentials: 'same-origin', headers, body: JSON.stringify({ body: submission.body, event: submission.event, headSha: submission.headSha }) },
  };
}

/** An approval needs no words; a comment or a request for changes needs them, unless pending comments go with it. */
export function canSubmit(event: ReviewEvent, body: string, pendingComments: boolean): boolean {
  return event === 'approve' || body.trim() !== '' || pendingComments;
}

/** The reason a submission failed, in GitHub's words when it gave any. */
export function reviewErrorText(status: number, payload: unknown): string {
  const said = messageOf(payload);
  return said === null ? `GitHub could not submit the review (HTTP ${status}).` : `GitHub could not submit the review: ${said}`;
}

function messageOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  for (const key of ['error', 'message']) {
    const value: unknown = Reflect.get(payload, key);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const errors: unknown = Reflect.get(payload, 'errors');
  if (!Array.isArray(errors)) return null;
  const words: string[] = [];
  for (const entry of errors) {
    const said = typeof entry === 'string' ? entry.trim() : messageOf(entry);
    if (said !== null && said !== '') words.push(said);
  }
  return words.length > 0 ? words.join(' ') : null;
}

function viewerLogin(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="user-login"]')?.content.trim() ?? '';
}

/** The pull request's author as the page header names them ("X wants to merge"), in either UI. */
function authorLogin(): string | null {
  const react = [...document.querySelectorAll<HTMLAnchorElement>('[data-component="PageHeader"] a.text-bold[href]')].find((link) => /^\/[^/]+\/?$/.test(link.getAttribute('href') ?? ''));
  const legacy = document.querySelector<HTMLAnchorElement>('.gh-header-meta a.author');
  const login = (react ?? legacy)?.textContent?.trim().replace(/^@/, '') ?? '';
  return login === '' ? null : login;
}

function fetchNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="fetch-nonce"]')?.content ?? '';
}

/** The tab bar's line counts: the group in the pull request header (not a diff's, not Geld's narrow mirror). */
function anchorOf(groups: readonly HeaderStatGroup[]): HTMLElement | null {
  for (const group of groups) {
    const host = group.host;
    if (!host.isConnected || host.closest(`[${OWN_UI_ATTRIBUTE}]`) !== null) continue;
    if (host.id === 'diffstat' || host.closest('[data-component="PageHeader"], .gh-header, #partial-discussion-header') !== null) return host;
  }
  return null;
}

interface Draft {
  body: string;
  event: ReviewEvent;
}

interface Mounted {
  readonly button: HTMLButtonElement;
  host: HTMLElement | null;
  readonly label: HTMLElement;
  /** "Submit review 1": the reader's pending comments, as GitHub's button counts them. */
  readonly counter: HTMLElement;
  pullPath: string;
  context: QuickReviewContext;
  /** The open overlay: the verdict menu or the comment box, never both. */
  panel: HTMLElement | null;
  /** A review on its way: the menu and the box wait for it. */
  sending: boolean;
  submittedTimer: number;
  /** The pending comments last read for {@link pendingFor}; null until read (or when GitHub could not say). */
  pending: readonly PendingComment[] | null;
  pendingFor: string | null;
}

let mounted: Mounted | null = null;
const drafts = new Map<string, Draft>();
let panelIds = 0;

function draftFor(pullPath: string): Draft {
  let draft = drafts.get(pullPath);
  if (draft === undefined) {
    draft = { body: '', event: 'comment' };
    drafts.set(pullPath, draft);
  }
  return draft;
}

/** Place (or keep) the button before the tab bar's line counts; remove it where it does not belong. */
export function applyQuickReview(enabled: boolean, context: QuickReviewContext): void {
  const pullPath = pullPathOf(window.location.pathname);
  const anchor = enabled && context.page.kind.startsWith('pull') && pullPath !== null && viewerLogin() !== '' ? anchorOf(context.groups) : null;
  if (anchor === null || pullPath === null) {
    removeQuickReview();
    return;
  }
  if (mounted === null) mounted = createButton(pullPath, context);
  if (mounted.pullPath !== pullPath) {
    closePanel();
    mounted.pullPath = pullPath;
  }
  mounted.context = context;
  if (mounted.pendingFor !== pullPath) void loadPending(mounted);
  showCount(mounted);
  if (anchor.previousElementSibling !== mounted.button) anchor.insertAdjacentElement('beforebegin', mounted.button);
  const host = anchor.parentElement;
  if (mounted.host !== host) {
    mounted.host?.removeAttribute(ATTR_HOST);
    mounted.host = host;
  }
  if (host !== null && !host.hasAttribute(ATTR_HOST)) host.setAttribute(ATTR_HOST, '');
  // Written only when it changes: every write is a mutation record, and passes run on mutations.
  if (!document.documentElement.hasAttribute(ATTR_ACTIVE)) document.documentElement.setAttribute(ATTR_ACTIVE, '');
}

export function removeQuickReview(): void {
  if (document.documentElement.hasAttribute(ATTR_ACTIVE)) document.documentElement.removeAttribute(ATTR_ACTIVE);
  if (mounted === null) return;
  closePanel();
  window.clearTimeout(mounted.submittedTimer);
  mounted.host?.removeAttribute(ATTR_HOST);
  mounted.button.remove();
  mounted = null;
}

function createButton(pullPath: string, context: QuickReviewContext): Mounted {
  const label = createElement('span', {}, ['Submit review']);
  const counter = createElement('span', { class: 'Counter geld-quick-review__count', hidden: '' });
  const button = createElement(
    'button',
    { type: 'button', class: `btn btn-sm btn-primary ${BUTTON_CLASS}`, [OWN_UI_ATTRIBUTE]: '', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    [label, counter, svgFromString(ICON_TRIANGLE_DOWN)],
  );
  const state: Mounted = { button, host: null, label, counter, pullPath, context, panel: null, sending: false, submittedTimer: 0, pending: null, pendingFor: null };
  button.addEventListener('click', () => {
    if (state.panel !== null) closePanel();
    else if (!state.sending) openMenu(state);
  });
  return state;
}

function closePanel(restoreFocus = false): void {
  if (mounted === null || mounted.panel === null) return;
  mounted.panel.remove();
  mounted.panel = null;
  mounted.button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  window.removeEventListener('resize', positionPanel);
  if (restoreFocus) mounted.button.focus();
}

function onOutsidePointer(event: PointerEvent): void {
  if (mounted === null || mounted.panel === null) return;
  const target = event.target;
  if (target instanceof Node && (mounted.panel.contains(target) || mounted.button.contains(target))) return;
  closePanel();
}

/** Under the button, its right edge on the button's, inside the viewport; in page coordinates, so it scrolls with the bar. */
function positionPanel(): void {
  if (mounted === null || mounted.panel === null || !mounted.button.isConnected) return;
  const rect = mounted.button.getBoundingClientRect();
  const width = mounted.panel.offsetWidth;
  const left = Math.max(16, Math.min(rect.right - width, document.documentElement.clientWidth - width - 16));
  mounted.panel.style.top = `${Math.round(rect.bottom + window.scrollY + 4)}px`;
  mounted.panel.style.left = `${Math.round(left + window.scrollX)}px`;
}

function showPanel(state: Mounted, panel: HTMLElement): void {
  closePanel();
  state.panel = panel;
  state.button.setAttribute('aria-expanded', 'true');
  document.body.append(panel);
  positionPanel();
  document.addEventListener('pointerdown', onOutsidePointer, true);
  window.addEventListener('resize', positionPanel);
}

function isAuthorViewing(): boolean {
  return authorLogin()?.toLowerCase() === viewerLogin().toLowerCase();
}

/** Read the reader's pending comments for the button's pull request, once per visit and again when the box opens. */
async function loadPending(state: Mounted): Promise<readonly PendingComment[] | null> {
  const pullPath = state.pullPath;
  state.pendingFor = pullPath;
  const pending = await fetchPendingComments(pullPath);
  if (state.pullPath !== pullPath) return null;
  state.pending = pending;
  showCount(state);
  return pending;
}

function pendingCount(state: Mounted): number {
  return pendingCountOnPage() ?? state.pending?.length ?? 0;
}

/** GitHub's own count (live on the Files changed tab, where its hidden button tracks new comments), else the last read. */
function showCount(state: Mounted): void {
  const count = pendingCount(state);
  const text = count > 0 ? String(count) : '';
  if (state.counter.textContent !== text) state.counter.textContent = text;
  if (state.counter.hidden !== (count === 0)) state.counter.hidden = count === 0;
  const name = count > 0 ? `Submit review, ${count} pending ${count === 1 ? 'comment' : 'comments'}` : 'Submit review';
  if (state.button.getAttribute('aria-label') !== name) state.button.setAttribute('aria-label', name);
}

/**
 * Send one review. On success the box's draft goes, and the Files changed
 * tab (or any tab with pending comments) reloads: GitHub's view still shows
 * the comments just published as pending until it does. Elsewhere the
 * button says what went through for a moment.
 */
async function sendReview(state: Mounted, event: ReviewEvent, body: string): Promise<string | null> {
  const headSha = state.context.headSha() ?? detectHeadSha();
  if (headSha === null) return 'Could not read the pull request’s head commit. Reload the page and try again.';
  const pullPath = state.pullPath;
  const { url, init } = submitReviewRequest(pullPath, { body, event, headSha }, fetchNonce());
  state.sending = true;
  state.label.textContent = 'Submitting…';
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      return reviewErrorText(response.status, payload);
    }
    drafts.delete(pullPath);
    if (state.context.page.kind === 'pull-files' || pendingCount(state) > 0) {
      window.location.reload();
      return null;
    }
    showDone(state, EVENT_INFO[event].done);
    return null;
  } catch {
    return 'GitHub could not submit the review.';
  } finally {
    state.sending = false;
    if (state.label.textContent === 'Submitting…') state.label.textContent = 'Submit review';
  }
}

/**
 * The verdicts as a menu under the button, one row each: Comment opens the
 * comment box (a comment needs words); Approve and Request changes send at
 * once, and the comment button at the end of their row opens the box with
 * that verdict chosen. What the author cannot do stays, disabled, with
 * GitHub's reason in place of the note.
 */
function openMenu(state: Mounted): void {
  const isAuthor = isAuthorViewing();
  void loadPending(state);
  const items: HTMLButtonElement[] = [];
  const rows = menuRows(isAuthor).map((row) => {
    const info = EVENT_INFO[row.event];
    const main = createElement(
      'button',
      { type: 'button', class: 'geld-quick-review__item', 'data-event': row.event },
      [
        createElement('span', { class: 'geld-quick-review__glyph', 'data-tone': info.tone }, [svgFromString(info.icon)]),
        createElement('span', { class: 'geld-quick-review__item-label' }, [info.label]),
        // Titles only: the author's reason a verdict is closed to them is the row's tooltip, and read with the button.
        ...(row.reason === null ? [] : [createElement('span', { class: 'sr-only' }, [`. ${row.reason}`])]),
      ],
    );
    main.disabled = row.disabled;
    items.push(main);
    main.addEventListener('click', () => {
      if (!row.direct) {
        openComposer(state, row.event, null);
        return;
      }
      closePanel(true);
      void sendReview(state, row.event, '').then((failure) => {
        // GitHub may want words for this one (a request for changes with nothing pending): ask for them, with its reason.
        if (failure !== null) openComposer(state, row.event, failure);
      });
    });
    const parts: Node[] = [main];
    if (row.withComment) {
      const words = `${info.label} with a comment`;
      const comment = createElement('button', { type: 'button', class: 'geld-quick-review__with-comment', 'aria-label': words, title: words }, [svgFromString(ICON_COMMENT)]);
      comment.disabled = row.disabled;
      comment.addEventListener('click', () => openComposer(state, row.event, null));
      items.push(comment);
      parts.push(comment);
    }
    return createElement('li', { class: `geld-quick-review__row${row.disabled ? ' geld-quick-review__row--disabled' : ''}`, ...(row.reason === null ? {} : { title: row.reason }) }, parts);
  });
  const menu = createElement('div', { class: `Overlay ${PANEL_CLASS} ${PANEL_CLASS}--menu`, [OWN_UI_ATTRIBUTE]: '', role: 'dialog', 'aria-label': 'Submit review' }, [
    createElement('ul', { class: 'geld-quick-review__rows' }, rows),
  ]);
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const enabled = items.filter((item) => !item.disabled);
    const at = enabled.findIndex((item) => item === document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    enabled[(at + step + enabled.length) % enabled.length]?.focus();
  });
  showPanel(state, menu);
  items.find((item) => !item.disabled)?.focus({ preventScroll: true });
}

/** The comment box, its verdict chosen (from the menu) and, after a refused send, GitHub's reason above it. */
function openComposer(state: Mounted, initial: ReviewEvent, failure: string | null): void {
  const pullPath = state.pullPath;
  const draft = draftFor(pullPath);
  const isAuthor = isAuthorViewing();
  draft.event = isAuthor && EVENT_INFO[initial].authorNote !== null ? 'comment' : initial;

  panelIds += 1;
  const titleId = `geld-quick-review-${panelIds}-title`;
  const close = createElement('button', { type: 'button', class: 'close-button Overlay-closeButton', 'aria-label': 'Close' }, [svgFromString(ICON_X)]);
  const body = createElement('textarea', { class: 'form-control width-full geld-quick-review__body', placeholder: 'Leave a comment', 'aria-label': 'Review comment', rows: '6' });
  body.value = draft.body;
  const choices = EVENTS.map(({ value, label, note, authorNote }) => {
    const disabled = isAuthor && authorNote !== null;
    const input = createElement('input', { type: 'radio', name: `geld-review-event-${panelIds}`, value });
    input.checked = draft.event === value;
    input.disabled = disabled;
    input.addEventListener('change', () => {
      if (input.checked) draft.event = value;
      refresh();
    });
    return createElement('div', { class: `form-checkbox geld-quick-review__choice${disabled ? ' geld-quick-review__choice--disabled' : ''}` }, [
      createElement('label', {}, [input, ` ${label}`]),
      createElement('p', { class: 'note' }, [disabled && authorNote !== null ? authorNote : note]),
    ]);
  });
  const pendingSection = createElement('div', { class: 'geld-quick-review__pending' });
  const error = createElement('p', { class: 'geld-quick-review__error color-fg-danger', role: 'alert', hidden: '' });
  if (failure !== null) {
    error.textContent = failure;
    error.hidden = false;
  }
  const discard = createElement('button', { type: 'button', class: 'btn btn-danger', hidden: '' }, ['Discard review']);
  const cancel = createElement('button', { type: 'button', class: 'btn' }, ['Cancel']);
  const submit = createElement('button', { type: 'button', class: 'btn btn-primary' }, ['Submit review']);
  const panel = createElement('div', { class: `Overlay ${PANEL_CLASS}`, [OWN_UI_ATTRIBUTE]: '', role: 'dialog', 'aria-labelledby': titleId }, [
    createElement('div', { class: 'Overlay-header' }, [
      createElement('div', { class: 'Overlay-headerContentWrap' }, [
        createElement('div', { class: 'Overlay-titleWrap' }, [createElement('h1', { class: 'Overlay-title', id: titleId }, ['Finish your review'])]),
        createElement('div', { class: 'Overlay-actionWrap' }, [close]),
      ]),
    ]),
    createElement('div', { class: 'Overlay-body' }, [body, createElement('fieldset', { class: 'geld-quick-review__events' }, [createElement('legend', { class: 'sr-only' }, ['Review type']), ...choices]), pendingSection, error]),
    createElement('div', { class: 'Overlay-footer Overlay-footer--divided geld-quick-review__footer' }, [discard, createElement('div', { class: 'geld-quick-review__actions' }, [cancel, submit])]),
  ]);

  let pendingOpen = true;
  const refresh = (): void => {
    const pending = pendingCount(state);
    submit.disabled = state.sending || !canSubmit(draft.event, body.value, pending > 0);
    discard.hidden = pending === 0;
    discard.disabled = state.sending;
    renderPending(pendingSection, state.pending, pending, pendingOpen, () => {
      pendingOpen = !pendingOpen;
      refresh();
    });
  };
  const send = async (): Promise<void> => {
    if (submit.disabled) return;
    error.hidden = true;
    submit.textContent = 'Submitting…';
    const pending = sendReview(state, draft.event, body.value);
    refresh();
    const failed = await pending;
    submit.textContent = 'Submit review';
    if (failed === null) {
      if (state.panel === panel) closePanel(true);
      return;
    }
    error.textContent = failed;
    error.hidden = false;
    refresh();
  };

  body.addEventListener('input', () => {
    draft.body = body.value;
    refresh();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel(true);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  });
  close.addEventListener('click', () => closePanel(true));
  cancel.addEventListener('click', () => closePanel(true));
  submit.addEventListener('click', () => void send());
  discard.addEventListener('click', () => {
    // GitHub's own words and its own (native) confirmation, as its Discard review asks.
    if (!window.confirm('Are you sure you want to cancel? You will lose all your pending comments.')) return;
    state.sending = true;
    refresh();
    void discardPendingReview(pullPath).then((done) => {
      state.sending = false;
      if (!done) {
        error.textContent = 'GitHub could not discard the review.';
        error.hidden = false;
        refresh();
        return;
      }
      closePanel(true);
      // The Files changed tab still draws the discarded comments until it reloads.
      if (state.context.page.kind === 'pull-files') {
        window.location.reload();
        return;
      }
      state.pending = [];
      showCount(state);
    });
  });

  showPanel(state, panel);
  refresh();
  body.focus({ preventScroll: true });
  // Comments the reader left with "Start a review" go out with this review, words or not; read them afresh.
  void loadPending(state).then(() => {
    if (state.panel === panel) refresh();
  });
}

/**
 * "Pending comments N" under the choices, as GitHub's dialog lists them:
 * each comment's file and line (leading to it in the diff), the diff lines
 * up to it, and what was written. Folds, open at first. Nothing when there
 * are none; the count alone while GitHub's own count is ahead of the list
 * (a comment added on Files changed since the list was read).
 */
function renderPending(section: HTMLElement, comments: readonly PendingComment[] | null, count: number, open: boolean, onToggle: () => void): void {
  section.replaceChildren();
  section.hidden = count === 0;
  if (count === 0) return;
  const toggle = createElement('button', { type: 'button', class: 'geld-quick-review__pending-toggle', 'aria-expanded': String(open) }, [
    svgFromString(ICON_CHEVRON_DOWN),
    createElement('span', {}, ['Pending comments']),
    createElement('span', { class: 'Counter' }, [String(count)]),
  ]);
  toggle.addEventListener('click', onToggle);
  section.append(toggle);
  if (!open || comments === null) return;
  const list = createElement('ul', { class: 'geld-quick-review__pending-list' });
  for (const comment of comments) {
    const where = createElement('a', { class: 'geld-quick-review__pending-path Link--primary', href: comment.href ?? '#', title: comment.path }, [comment.path]);
    const head = createElement('div', { class: 'geld-quick-review__pending-head' }, [
      where,
      ...(comment.outdated ? [createElement('span', { class: 'Label Label--secondary' }, ['Outdated'])] : []),
      ...(comment.line === null ? [] : [createElement('span', { class: 'geld-quick-review__pending-line color-fg-muted' }, [`Line ${comment.line}`])]),
    ]);
    const lines = createElement(
      'table',
      { class: 'geld-quick-review__pending-diff' },
      [
        createElement(
          'tbody',
          {},
          comment.diffLines.map((line) => {
            const code = createElement('td', { class: 'geld-quick-review__pending-code' }, [line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : line.type === 'context' ? ' ' : '', githubMarkup(line.html)]);
            return createElement('tr', { 'data-type': line.type }, [
              createElement('td', { class: 'geld-quick-review__pending-num' }, [line.type === 'hunk' || line.left === null ? '' : String(line.left)]),
              createElement('td', { class: 'geld-quick-review__pending-num' }, [line.type === 'hunk' || line.right === null ? '' : String(line.right)]),
              code,
            ]);
          }),
        ),
      ],
    );
    const said = createElement('div', { class: 'geld-quick-review__pending-body markdown-body' });
    said.append(githubMarkup(comment.bodyHtml));
    list.append(createElement('li', { class: 'geld-quick-review__pending-item' }, [head, ...(comment.diffLines.length > 0 ? [lines] : []), said]));
  }
  section.append(list);
}

function showDone(state: Mounted, words: string): void {
  window.clearTimeout(state.submittedTimer);
  state.label.textContent = words;
  state.submittedTimer = window.setTimeout(() => {
    state.label.textContent = 'Submit review';
  }, SUBMITTED_MS);
}
