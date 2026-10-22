import { firstSentence } from '@geld/review';
import { createElement, OWN_UI_ATTRIBUTE, svgFromString } from './dom';
import type { HeaderStatGroup } from './header-stats';
import { detectHeadSha } from './head-sha';
import type { PageInfo } from './page';
import type { PendingComment } from './pending-review';
import { discardPendingReview, fetchPendingComments, linkOnFilesTab, pendingCountOnPage } from './pending-review';
import { inlineText } from './review/inline-text';
import { ICON_CHECK, ICON_CHECK_SEND, ICON_CHEVRON_DOWN, ICON_COMMENT, ICON_TRASH, ICON_X, ICON_X_SEND } from './ui/icons';

/**
 * The review controls in the pull request's tab bar, left of the line
 * counts, on every tab: one button group, [✓ | ✗ | 💬], Approve, Request
 * changes and Comment. A click opens the comment box with that verdict
 * chosen, so the box is also the confirmation; ⌘-click (Ctrl-click off a
 * Mac) on ✓ or ✗ sends it at once without a comment, while 💬 always opens
 * the box, being there for the words. GitHub's own Submit review exists
 * only on the Files changed tab and is React's, so this is Geld's, and it
 * sends the request GitHub's dialog sends (`PUT page_data/submit_review`,
 * verified Oct 2026), which needs nothing from that tab. While it is
 * mounted GitHub's button is hidden, so the action shows once.
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

const GROUP_CLASS = 'geld-quick-review';
const PANEL_CLASS = 'geld-quick-review__panel';
/** On `<html>` while the button is mounted; the stylesheet hides GitHub's own review button under it. */
const ATTR_ACTIVE = 'data-geld-quick-review';
/** On the box holding the button and the counts; the stylesheet centres both on the tabs there. */
const ATTR_HOST = 'data-geld-quick-review-host';
/** On the group while it rides a sticky header: `toolbar` (Files changed, where GitHub's own button would be) or `header` (every other tab). */
const ATTR_PLACE = 'data-geld-place';
/** GitHub's own review control, React's Files changed view or the classic one; hidden while the group is mounted. */
const GITHUB_REVIEW_CONTROL = '[class*="ReviewMenuButton"], details.js-reviews-container';
/** The toolbar that holds it and sticks to the top of the viewport as the diff scrolls. */
const STICKY_TOOLBAR = 'section[class*="stickyHeader"], .js-sticky';
const STICKY_REVIEW_CONTROL = `:is(${STICKY_TOOLBAR}) :is(${GITHUB_REVIEW_CONTROL})`;
/** The compact pull request header the other tabs show once the page header has scrolled away: `display: none` until it sticks. */
const STICKY_PR_HEADER = '[class*="prHeader"][class*="stickyHeader"]';

type Place = 'toolbar' | 'header';
const SUBMITTED_MS = 3000;
/** On the group while the instant key is held: ✓ and ✗ then send on a click, and the stylesheet swaps their glyphs for the sending ones. */
const ATTR_INSTANT = 'data-instant';

interface EventInfo {
  readonly value: ReviewEvent;
  readonly label: string;
  /** Whether the pull request's author may take it: GitHub refuses an author's own approval and request for changes. */
  readonly authorMay: boolean;
  /** The segment's glyph. */
  readonly icon: string;
  /** Its glyph while the instant key is held, for the verdicts a ⌘-click sends at once. */
  readonly instantIcon: string | null;
  /** The submit button's look in the comment box, as GitHub colours these verdicts. */
  readonly submitClass: string;
  /** What the controls say for a moment after it went through. */
  readonly done: string;
}

const EVENT_INFO: { readonly [E in ReviewEvent]: EventInfo } = {
  comment: { value: 'comment', label: 'Comment', authorMay: true, icon: ICON_COMMENT, instantIcon: null, submitClass: '', done: 'Review submitted' },
  approve: {
    value: 'approve',
    label: 'Approve',
    authorMay: false,
    icon: ICON_CHECK,
    instantIcon: ICON_CHECK_SEND,
    submitClass: 'btn-primary',
    done: 'Approved',
  },
  'request changes': {
    value: 'request changes',
    label: 'Request changes',
    authorMay: false,
    icon: ICON_X,
    instantIcon: ICON_X_SEND,
    submitClass: 'geld-quick-review__submit--danger',
    done: 'Changes requested',
  },
};

/** The segments, left to right: the verdicts first, the comment last (it carries the pending count). */
const SEGMENT_ORDER: readonly ReviewEvent[] = ['approve', 'request changes', 'comment'];

/** Whether a click asked to send at once, without the box: ⌘ on a Mac, Ctrl elsewhere, on ✓ or ✗ only. */
export function isInstantClick(event: ReviewEvent, click: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, mac: boolean): boolean {
  return event !== 'comment' && (mac ? click.metaKey : click.ctrlKey);
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const INSTANT_KEY = MAC ? '⌘' : 'Ctrl';

/**
 * A segment's tooltip, one entry per line: its verdict and the key for a
 * 1-click review, or what a click does while that key is held.
 */
export function segmentHint(event: ReviewEvent, instantKey: string, held = false): readonly string[] {
  const info = EVENT_INFO[event];
  if (info.instantIcon === null) return [info.label];
  if (held) return [`${info.label} without comments`];
  return [info.label, `${instantKey} 1-click review`];
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
    // GitHub hides the header's counts on narrow screens: placed there, the button would be hidden with them while
    // GitHub's own was hidden for it, leaving no way to review. A style read, not a layout one.
    if (!host.checkVisibility()) continue;
    if (host.id === 'diffstat' || host.closest('[data-component="PageHeader"], .gh-header, #partial-discussion-header') !== null) return host;
  }
  return null;
}

interface Draft {
  body: string;
  event: ReviewEvent;
}

interface Mounted {
  /** What is placed in the tab bar: the group, with the status line before it. */
  readonly root: HTMLElement;
  readonly segments: { readonly [E in ReviewEvent]: HTMLButtonElement };
  /** Primer's button group holding the segments the reader may use. */
  readonly group: HTMLElement;
  /** "Approved", "Submitting…": what the controls have just done, read out as it changes. */
  readonly status: HTMLElement;
  host: HTMLElement | null;
  /** On the group's top-right corner: the reader's pending comments, as GitHub's button counts them. */
  readonly counter: HTMLElement;
  /** The segment the open box came from, for its pressed look and for focus when it closes. */
  opener: ReviewEvent | null;
  isAuthor: boolean | null;
  pullPath: string;
  context: QuickReviewContext;
  /** The open comment box. */
  panel: HTMLElement | null;
  /** Gives the open box another verdict, keeping its words. */
  retarget: ((event: ReviewEvent) => void) | null;
  /** A review on its way: the controls and the box wait for it. */
  sending: boolean;
  submittedTimer: number;
  /** The pending comments last read for {@link pendingFor}; null until read (or when GitHub could not say). */
  pending: readonly PendingComment[] | null;
  pendingFor: string | null;
  /** Stops following the instant key. */
  readonly keys: AbortController;
  /** The tab bar's line counts the group stands before, from the last pass. */
  anchor: HTMLElement | null;
  /** The sticky headers being watched for when they stick (the Files changed toolbar, the compact header), and the watch. */
  toolbar: Element | null;
  header: Element | null;
  readonly stickyWatch: MutationObserver;
  /** Whether the Files changed toolbar is stuck, read from its box on scroll (never on a pass, which must not measure). */
  toolbarStuck: boolean;
}

let mounted: Mounted | null = null;
const drafts = new Map<string, Draft>();

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
  if (mounted === null) mounted = createControls(pullPath, context);
  if (mounted.pullPath !== pullPath) {
    closePanel();
    mounted.pullPath = pullPath;
    // The last pull request's pending comments are not this one's: none until this one's are read.
    mounted.pending = null;
  }
  mounted.context = context;
  if (mounted.pendingFor !== pullPath) void loadPending(mounted);
  showCount(mounted);
  showAuthor(mounted);
  mounted.anchor = anchor;
  watchSticky(mounted);
  place(mounted);
  const host = anchor.parentElement;
  if (mounted.host !== host) {
    mounted.host?.removeAttribute(ATTR_HOST);
    mounted.host = host;
  }
  if (host !== null && !host.hasAttribute(ATTR_HOST)) host.setAttribute(ATTR_HOST, '');
  // Written only when it changes: every write is a mutation record, and passes run on mutations.
  if (!document.documentElement.hasAttribute(ATTR_ACTIVE)) document.documentElement.setAttribute(ATTR_ACTIVE, '');
}

function isStuck(element: Element): boolean {
  // React's class is `is-stuck__<hash>`, the classic toolbar's `is-stuck`.
  return [...element.classList].some((name) => name === 'is-stuck' || name.startsWith('is-stuck__'));
}

/**
 * Whether the Files changed toolbar is stuck, from its box: a sticky element
 * stands at its `top` once stuck and below it in its place. GitHub's own
 * `is-stuck` class comes a frame after the toolbar has visibly stuck (its
 * observer reports after paint), the first time noticeably, so the class
 * alone left the toolbar showing without the group for a moment.
 */
function measureToolbarStuck(toolbar: Element): boolean {
  const top = Number.parseFloat(getComputedStyle(toolbar).top);
  return toolbar.getBoundingClientRect().top <= (Number.isFinite(top) ? top : 0) + 0.5;
}

/**
 * Where the group rides while a sticky header shows: the Files changed
 * toolbar just before GitHub's hidden review button, or the end of the
 * compact pull request header's title row the other tabs show; null while neither is
 * stuck, the group in view in the tab bar.
 */
function stickyPlace(state: Mounted): { readonly place: Place; readonly put: (root: HTMLElement) => void; readonly placed: (root: HTMLElement) => boolean } | null {
  const control = document.querySelector<HTMLElement>(STICKY_REVIEW_CONTROL);
  if (control !== null) {
    if (!state.toolbarStuck) return null;
    return { place: 'toolbar', put: (root) => control.insertAdjacentElement('beforebegin', root), placed: (root) => control.previousElementSibling === root };
  }
  const header = document.querySelector<HTMLElement>(STICKY_PR_HEADER);
  if (header === null || !isStuck(header)) return null;
  // Inside the title row, after the title (which gives way), so the row's centred width and padding hold it as the page's content edge.
  const row = header.querySelector<HTMLElement>('[class*="TitleArea"]') ?? header;
  return { place: 'header', put: (root) => row.append(root), placed: (root) => row.lastElementChild === root };
}

/**
 * Follow the sticky headers' class, which GitHub flips as they stick and let
 * go, so the group moves in the same task rather than at the next pass; the
 * compact header shows on that very flip, so the move is never seen.
 */
function watchSticky(state: Mounted): void {
  const toolbar = document.querySelector(STICKY_REVIEW_CONTROL)?.closest(STICKY_TOOLBAR) ?? null;
  const header = document.querySelector(STICKY_PR_HEADER);
  if (toolbar === state.toolbar && header === state.header) return;
  const newToolbar = toolbar !== state.toolbar;
  state.stickyWatch.disconnect();
  state.toolbar = toolbar;
  state.header = header;
  for (const element of [toolbar, header]) if (element !== null) state.stickyWatch.observe(element, { attributes: true, attributeFilter: ['class'] });
  // A page opened (or restored) scrolled down: read the new toolbar's box once, off the pass, which must not measure.
  if (newToolbar) {
    requestAnimationFrame(() => {
      if (mounted === state) followToolbar(state);
    });
  }
}

/** Re-read the toolbar's box (scroll, or its class flipping) and move the group when that changes where it belongs. */
function followToolbar(state: Mounted): void {
  const toolbar = state.toolbar?.isConnected === true ? state.toolbar : null;
  const stuck = toolbar !== null && measureToolbarStuck(toolbar);
  if (stuck !== state.toolbarStuck) {
    state.toolbarStuck = stuck;
    place(state);
  }
}

/** In a stuck header, so it is always to hand while reviewing; otherwise before the tab bar's counts. */
function place(state: Mounted): void {
  const sticky = stickyPlace(state);
  if (sticky !== null) {
    if (!sticky.placed(state.root)) sticky.put(state.root);
  } else if (state.anchor !== null && state.anchor.previousElementSibling !== state.root) {
    state.anchor.insertAdjacentElement('beforebegin', state.root);
  }
  const place = sticky?.place ?? null;
  if (state.root.getAttribute(ATTR_PLACE) !== place) {
    if (place === null) state.root.removeAttribute(ATTR_PLACE);
    else state.root.setAttribute(ATTR_PLACE, place);
    positionPanel();
  }
}

export function removeQuickReview(): void {
  if (document.documentElement.hasAttribute(ATTR_ACTIVE)) document.documentElement.removeAttribute(ATTR_ACTIVE);
  if (mounted === null) return;
  closePanel();
  window.clearTimeout(mounted.submittedTimer);
  mounted.host?.removeAttribute(ATTR_HOST);
  mounted.keys.abort();
  mounted.stickyWatch.disconnect();
  mounted.root.remove();
  mounted = null;
}

let tipIds = 0;

/**
 * A segment's words in GitHub's own tooltip (the page defines `tool-tip`; one
 * made here is upgraded like its own), read as its description; the
 * segment's name is its `aria-label`. Where the page has no `tool-tip` (an
 * Enterprise version before it) the words are its title. Lines are broken
 * with `<br>`, which the tooltip shows and a screen reader reads as a pause.
 */
function describe(button: HTMLButtonElement, lines: readonly string[]): HTMLElement | null {
  const tip = button.closest(`.${GROUP_CLASS}`)?.querySelector(`[id="${button.id}-tip"]`) ?? null;
  if (tip instanceof HTMLElement) {
    if (tip.textContent !== lines.join('')) tip.replaceChildren(...withBreaks(lines));
    return null;
  }
  if (document.querySelector('tool-tip') === null) {
    button.title = lines.join('\n');
    return null;
  }
  const created = document.createElement('tool-tip');
  for (const [name, value] of Object.entries({ id: `${button.id}-tip`, for: button.id, popover: 'manual', 'data-direction': 's', 'data-type': 'description', class: 'sr-only position-absolute', role: 'tooltip' })) created.setAttribute(name, value);
  created.append(...withBreaks(lines));
  return created;
}

function withBreaks(lines: readonly string[]): (string | HTMLElement)[] {
  return lines.flatMap((line, index) => (index === 0 ? [line] : [document.createElement('br'), line]));
}

function createControls(pullPath: string, context: QuickReviewContext): Mounted {
  const counter = createElement('span', { class: 'geld-quick-review__count', 'aria-hidden': 'true', hidden: '' });
  const status = createElement('span', { class: 'geld-quick-review__status', role: 'status' });
  const segment = (event: ReviewEvent): HTMLButtonElement => {
    const info = EVENT_INFO[event];
    tipIds += 1;
    return createElement(
      'button',
      { type: 'button', id: `geld-quick-review-${tipIds}`, class: 'btn btn-sm BtnGroup-item geld-quick-review__segment', 'data-event': event, 'aria-label': info.label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      [
        createElement('span', { class: 'geld-quick-review__glyph' }, [svgFromString(info.icon)]),
        ...(info.instantIcon === null ? [] : [createElement('span', { class: 'geld-quick-review__glyph geld-quick-review__glyph--instant' }, [svgFromString(info.instantIcon)])]),
      ],
    );
  };
  const segments = { approve: segment('approve'), 'request changes': segment('request changes'), comment: segment('comment') };
  // Primer rounds the group's outer corners on `:first-child` / `:last-child`: the tooltips stand beside it, not between.
  const group = createElement('div', { class: 'BtnGroup geld-quick-review__group', role: 'group', 'aria-label': 'Submit review' }, SEGMENT_ORDER.map((event) => segments[event]));
  const tips = SEGMENT_ORDER.flatMap((event) => describe(segments[event], segmentHint(event, INSTANT_KEY)) ?? []);
  // The count is a badge on the group's corner, outside it: inside, Primer's `:last-child` rounding would land on it.
  const root = createElement('span', { class: GROUP_CLASS, [OWN_UI_ATTRIBUTE]: '' }, [status, createElement('span', { class: 'geld-quick-review__badged' }, [group, counter]), ...tips]);
  const keys = new AbortController();
  const stickyWatch = new MutationObserver(() => {
    if (mounted !== state) return;
    followToolbar(state);
    place(state);
  });
  const state: Mounted = {
    root,
    segments,
    group,
    status,
    host: null,
    counter,
    opener: null,
    isAuthor: null,
    pullPath,
    context,
    panel: null,
    retarget: null,
    sending: false,
    submittedTimer: 0,
    pending: null,
    pendingFor: null,
    keys,
    anchor: null,
    toolbar: null,
    header: null,
    stickyWatch,
    toolbarStuck: false,
  };
  // Scroll events come before the frame is painted, so a toolbar that sticks on this scroll has the group in that frame.
  window.addEventListener(
    'scroll',
    () => {
      if (mounted === state) followToolbar(state);
    },
    { passive: true, signal: keys.signal },
  );
  followInstantKey(root, keys.signal, () => describeSegments(state));
  for (const event of SEGMENT_ORDER) {
    segments[event].addEventListener('click', (click) => {
      if (state.sending) return;
      if (state.panel !== null && state.opener === event) {
        closePanel(true);
        return;
      }
      if (!isInstantClick(event, click, MAC)) {
        // Another verdict while the box is open: the box stays, words and all, and takes the new verdict.
        if (state.panel !== null && state.retarget !== null) state.retarget(event);
        else openComposer(state, event, null);
        return;
      }
      closePanel();
      void sendReview(state, event, '').then((failure) => {
        // GitHub may want words for this one (a request for changes with nothing pending): ask for them, with its reason.
        if (failure !== null) openComposer(state, event, failure);
      });
    });
  }
  return state;
}

/**
 * Mark the group while the instant key (⌘ on a Mac, Ctrl elsewhere) is held,
 * so ✓ and ✗ show before the click that they will send at once (their
 * glyphs gain an arrow, their tooltips say so). Read from every key event
 * and from the pointer over the group (the key may have gone down while
 * another window had focus); let go when the window loses focus.
 */
function followInstantKey(root: HTMLElement, signal: AbortSignal, onChange: () => void): void {
  const held = (on: boolean): void => {
    if (root.hasAttribute(ATTR_INSTANT) === on) return;
    root.toggleAttribute(ATTR_INSTANT, on);
    onChange();
  };
  const read = (event: KeyboardEvent | MouseEvent): void => held(MAC ? event.metaKey : event.ctrlKey);
  window.addEventListener('keydown', read, { capture: true, signal });
  window.addEventListener('keyup', read, { capture: true, signal });
  root.addEventListener('pointermove', read, { signal });
  window.addEventListener('blur', () => held(false), { signal });
}

function describeSegments(state: Mounted): void {
  const held = state.root.hasAttribute(ATTR_INSTANT);
  for (const event of SEGMENT_ORDER) describe(state.segments[event], segmentHint(event, INSTANT_KEY, held));
}

/**
 * On their own pull request the author has only 💬: ✓ and ✗ leave the group
 * (out of the DOM, not hidden, since Primer rounds the group's corners on
 * `:first-child`/`:last-child`). Re-read each pass, the header may come late.
 */
function showAuthor(state: Mounted): void {
  const isAuthor = isAuthorViewing();
  if (state.isAuthor === isAuthor) return;
  state.isAuthor = isAuthor;
  state.group.replaceChildren(...SEGMENT_ORDER.filter((event) => !isAuthor || EVENT_INFO[event].authorMay).map((event) => state.segments[event]));
}

function closePanel(restoreFocus = false): void {
  if (mounted === null || mounted.panel === null) return;
  mounted.panel.remove();
  mounted.panel = null;
  mounted.retarget = null;
  const opener = mounted.opener === null ? null : mounted.segments[mounted.opener];
  mounted.opener = null;
  for (const event of SEGMENT_ORDER) mounted.segments[event].setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  window.removeEventListener('resize', positionPanel);
  if (restoreFocus) opener?.focus();
}

function onOutsidePointer(event: PointerEvent): void {
  if (mounted === null || mounted.panel === null) return;
  const target = event.target;
  if (target instanceof Node && (mounted.panel.contains(target) || mounted.root.contains(target))) return;
  closePanel();
}

/**
 * Under the group, its right edge on the group's, inside the viewport: in
 * page coordinates under the tab bar, so it scrolls with the bar, and fixed
 * under the stuck toolbar, which stays put as the page scrolls.
 */
function positionPanel(): void {
  if (mounted === null || mounted.panel === null || !mounted.root.isConnected) return;
  const fixed = mounted.root.hasAttribute(ATTR_PLACE);
  const rect = mounted.root.getBoundingClientRect();
  const width = mounted.panel.offsetWidth;
  const left = Math.max(16, Math.min(rect.right - width, document.documentElement.clientWidth - width - 16));
  mounted.panel.style.position = fixed ? 'fixed' : '';
  mounted.panel.style.top = `${Math.round(rect.bottom + (fixed ? 0 : window.scrollY) + 4)}px`;
  mounted.panel.style.left = `${Math.round(left + (fixed ? 0 : window.scrollX))}px`;
  // Fixed under a sticky header, scrolling the page cannot reach what overflows the window: the box keeps to the room
  // left below it and Primer's Overlay scrolls its body, so the buttons in its footer stay in view.
  mounted.panel.style.maxHeight = fixed ? `${Math.max(160, Math.round(window.innerHeight - rect.bottom - 20))}px` : '';
}

function showPanel(state: Mounted, panel: HTMLElement, opener: ReviewEvent): void {
  closePanel();
  state.panel = panel;
  state.opener = opener;
  state.segments[opener].setAttribute('aria-expanded', 'true');
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
  const name = count > 0 ? `Comment, ${count} pending ${count === 1 ? 'comment' : 'comments'}` : 'Comment';
  if (state.segments.comment.getAttribute('aria-label') !== name) state.segments.comment.setAttribute('aria-label', name);
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
  state.root.setAttribute('aria-busy', 'true');
  window.clearTimeout(state.submittedTimer);
  state.status.textContent = 'Submitting…';
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
    state.root.removeAttribute('aria-busy');
    if (state.status.textContent === 'Submitting…') state.status.textContent = '';
  }
}

/**
 * The comment box: the words, the pending comments and Cancel beside a
 * submit button that names the verdict in its colour ("Approve" green,
 * "Request changes" red, "Comment" grey). No title and no choices: the
 * segment that opened it chose the verdict, and another segment changes it
 * in place. After a refused send, GitHub's reason above the buttons.
 */
function openComposer(state: Mounted, initial: ReviewEvent, failure: string | null): void {
  const pullPath = state.pullPath;
  const draft = draftFor(pullPath);
  const allowed = (event: ReviewEvent): ReviewEvent => (isAuthorViewing() && !EVENT_INFO[event].authorMay ? 'comment' : event);
  draft.event = allowed(initial);

  const body = createElement('textarea', { class: 'form-control width-full geld-quick-review__body', placeholder: 'Leave a comment', 'aria-label': 'Review comment', rows: '4' });
  body.value = draft.body;
  const pendingSection = createElement('div', { class: 'geld-quick-review__pending' });
  const error = createElement('p', { class: 'geld-quick-review__error color-fg-danger', role: 'alert', hidden: '' });
  if (failure !== null) {
    error.textContent = failure;
    error.hidden = false;
  }
  const discard = createElement('button', { type: 'button', class: 'btn btn-sm btn-invisible geld-quick-review__discard', hidden: '' }, [svgFromString(ICON_TRASH), 'Discard review']);
  const cancel = createElement('button', { type: 'button', class: 'btn btn-sm btn-invisible' }, ['Cancel']);
  const submit = createElement('button', { type: 'button', class: 'btn btn-sm' });
  const panel = createElement('div', { class: `Overlay ${PANEL_CLASS}`, [OWN_UI_ATTRIBUTE]: '', role: 'dialog' }, [
    createElement('div', { class: 'Overlay-body' }, [body, pendingSection, error]),
    createElement('div', { class: 'Overlay-footer geld-quick-review__footer' }, [discard, createElement('div', { class: 'geld-quick-review__actions' }, [cancel, submit])]),
  ]);

  let pendingOpen = false;
  const showVerdict = (): void => {
    const info = EVENT_INFO[draft.event];
    submit.className = `btn btn-sm geld-quick-review__submit ${info.submitClass}`.trim();
    if (!state.sending) submit.textContent = info.label;
    panel.setAttribute('aria-label', info.label);
  };
  const refresh = (): void => {
    const pending = pendingCount(state);
    submit.disabled = state.sending || !canSubmit(draft.event, body.value, pending > 0);
    discard.hidden = pending === 0;
    discard.disabled = state.sending;
    renderPending(pendingSection, pullPath, state.pending, pending, pendingOpen, () => {
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
    showVerdict();
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

  showPanel(state, panel, initial);
  state.retarget = (event) => {
    draft.event = allowed(event);
    if (state.opener !== null) state.segments[state.opener].setAttribute('aria-expanded', 'false');
    state.opener = event;
    state.segments[event].setAttribute('aria-expanded', 'true');
    error.hidden = true;
    showVerdict();
    refresh();
    body.focus({ preventScroll: true });
  };
  showVerdict();
  refresh();
  body.focus({ preventScroll: true });
  // Comments the reader left with "Start a review" go out with this review, words or not; read them afresh.
  void loadPending(state).then(() => {
    if (state.panel === panel) refresh();
  });
}

/**
 * "Pending comments N" under the words, one line per comment as the
 * digest lists threads: the comment's first sentence, then its file and
 * line, the line leading to the comment on the Files changed tab. Folds,
 * closed at first. Nothing when there are none; the count alone while
 * GitHub's own count is ahead of the list (a comment added on Files changed
 * since the list was read).
 */
function renderPending(section: HTMLElement, pullPath: string, comments: readonly PendingComment[] | null, count: number, open: boolean, onToggle: () => void): void {
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
  const tabIsChanges = location.pathname.startsWith(`${pullPath}/changes`) || document.querySelector(`a[href="${pullPath}/changes"]`) !== null;
  const list = createElement('ul', { class: 'geld-quick-review__pending-list' });
  for (const comment of comments) {
    const file = comment.path.split('/').pop() ?? comment.path;
    const where = comment.line === null ? file : `${file}:${comment.line}`;
    const link = createElement('a', { class: 'geld-quick-review__pending-row', href: comment.href === null ? '#' : linkOnFilesTab(comment.href, pullPath, tabIsChanges), title: `${comment.path}${comment.line === null ? '' : `, line ${comment.line}`}` }, [
      createElement('span', { class: 'geld-quick-review__pending-glyph' }, [svgFromString(ICON_COMMENT)]),
      createElement('span', { class: 'geld-quick-review__pending-text' }, inlineText(firstSentence(comment.body))),
      createElement('span', { class: 'geld-quick-review__pending-where' }, [where]),
      ...(comment.outdated ? [createElement('span', { class: 'Label Label--secondary' }, ['Outdated'])] : []),
    ]);
    list.append(createElement('li', {}, [link]));
  }
  section.append(list);
}

function showDone(state: Mounted, words: string): void {
  window.clearTimeout(state.submittedTimer);
  state.status.textContent = words;
  state.submittedTimer = window.setTimeout(() => {
    state.status.textContent = '';
  }, SUBMITTED_MS);
}
