/**
 * What the reader may do to the pull request beyond reviewing it, and the
 * requests that do it, as GitHub's React merge box reads and sends them
 * (verified Oct 2026 by reading its bundle and capturing its requests with
 * the writes stubbed): `GET page_data/merge_box?merge_method=…&bypass_requirements=…`
 * says whether the reader can merge (directly, or only by bypassing the
 * rules), close and mark a draft ready, and whose verdicts stand; `POST page_data/merge`
 * merges; `POST page_data/close_pull_request` closes; `POST page_data/mark_ready_for_review`
 * takes a draft out of draft. Same origin and session as the page, so they work from any tab.
 */

export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

export interface MergeBox {
  readonly open: boolean;
  readonly draft: boolean;
  readonly canClose: boolean;
  /** Whether the reader may take the draft out of draft ("Ready for review"). */
  readonly canMarkReady: boolean;
  /** Each reviewer's standing verdict, as GitHub counts them (their latest approval or request for changes, dismissed ones gone). */
  readonly verdicts: readonly ReviewVerdict[];
  /** Whether GitHub would merge it now with the method asked for (the rules, checks, reviews and conflicts all allow it). */
  readonly mergeable: boolean;
  /** Whether the reader is an admin GitHub lets bypass the rules that block it. */
  readonly canBypass: boolean;
  /** The direct merge methods the repository allows the reader, GitHub's default first. */
  readonly methods: readonly MergeMethod[];
  /** GitHub's prefilled commit for the method asked for (none for a rebase). */
  readonly commitTitle: string;
  readonly commitMessage: string;
  readonly authorEmail: string | null;
  /** Part of a GitHub stack: GitHub merges it through the stack's own request, `enqueue_stack`, not `merge`. */
  readonly stacked: boolean;
}

export interface ReviewVerdict {
  readonly login: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED';
  /** The review's id, as its timeline anchor names it (`pullrequestreview-<id>`). */
  readonly id: number | null;
}

/** What the controls offer: a merge, a merge only past the rules (GitHub's bypass), or none. */
export type MergeOffer = 'merge' | 'bypass' | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isMethod(value: unknown): value is MergeMethod {
  return value === 'MERGE' || value === 'SQUASH' || value === 'REBASE';
}

/** A `page_data/merge_box` answer, or null when it is not one. */
export function parseMergeBox(payload: unknown): MergeBox | null {
  if (!isRecord(payload) || !isRecord(payload.pullRequest)) return null;
  const pull = payload.pullRequest;
  const requirements = isRecord(payload.mergeRequirements) ? payload.mergeRequirements : {};
  const actions = Array.isArray(pull.viewerMergeActions) ? pull.viewerMergeActions : [];
  const direct = actions.find((action): action is Record<string, unknown> => isRecord(action) && action.name === 'DIRECT_MERGE');
  const allowed = direct !== undefined && direct.allowableStatus === 'ALLOWED' && Array.isArray(direct.mergeMethods) ? direct.mergeMethods : [];
  const methods = allowed
    .filter((method): method is Record<string, unknown> => isRecord(method) && method.allowableStatus === 'ALLOWED' && isMethod(method.name))
    .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
    .map((method) => method.name)
    .filter(isMethod);
  const email = stringOf(requirements.defaultCommitAuthorEmail);
  const conditions = Array.isArray(requirements.conditions) ? requirements.conditions : [];
  const stacked = conditions.some((condition) => isRecord(condition) && condition.type === 'STACK' && condition.isStacked === true);
  const reviews = Array.isArray(pull.latestOpinionatedReviews) ? pull.latestOpinionatedReviews : [];
  const verdicts: ReviewVerdict[] = [];
  for (const review of reviews) {
    if (!isRecord(review) || !isRecord(review.author)) continue;
    const login = stringOf(review.author.login);
    const id = typeof review.id === 'number' && Number.isFinite(review.id) ? review.id : null;
    if (login !== '' && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')) verdicts.push({ login, state: review.state, id });
  }
  return {
    open: pull.state === 'OPEN',
    draft: pull.isDraft === true,
    canClose: pull.viewerCanClose === true,
    canMarkReady: pull.viewerCanMarkReadyForReview === true,
    verdicts,
    mergeable: requirements.state === 'MERGEABLE',
    canBypass: pull.viewerCanAdminBypassMergeRequirements === true,
    methods,
    commitTitle: stringOf(requirements.commitMessageHeadline),
    commitMessage: stringOf(requirements.commitMessageBody),
    authorEmail: email === '' ? null : email,
    stacked,
  };
}

/**
 * The merge on offer: none on a draft, a closed pull request or one whose
 * repository allows the reader no direct merge; a plain merge when GitHub
 * would take it now; a bypass when it would take it only past the rules
 * (`asBypass` is the same box read with `bypass_requirements=true`).
 */
export function mergeOffer(box: MergeBox, asBypass: MergeBox | null): MergeOffer {
  if (!box.open || box.draft || box.methods.length === 0) return null;
  if (box.mergeable) return 'merge';
  if (box.canBypass && asBypass?.mergeable === true) return 'bypass';
  return null;
}

/** "Squash and merge", the words GitHub's merge box gives each method. */
export const METHOD_LABEL: { readonly [M in MergeMethod]: string } = { MERGE: 'Create a merge commit', SQUASH: 'Squash and merge', REBASE: 'Rebase and merge' };

/** "Confirm squash and merge", GitHub's confirmation for each method. */
export const METHOD_CONFIRM: { readonly [M in MergeMethod]: string } = { MERGE: 'Confirm merge', SQUASH: 'Confirm squash and merge', REBASE: 'Confirm rebase and merge' };

export interface MergeSubmission {
  readonly method: MergeMethod;
  readonly commitTitle: string;
  readonly commitMessage: string;
  readonly authorEmail: string | null;
  readonly bypass: boolean;
  readonly stacked: boolean;
}

function headers(nonce: string, json: boolean): Record<string, string> {
  const out: Record<string, string> = { Accept: 'application/json', 'GitHub-Verified-Fetch': 'true', 'X-Requested-With': 'XMLHttpRequest' };
  if (json) out['Content-Type'] = 'application/json';
  if (nonce !== '') out['X-Fetch-Nonce'] = nonce;
  return out;
}

export function mergeBoxUrl(pullPath: string, method: MergeMethod, bypass: boolean): string {
  return `${pullPath}/page_data/merge_box?merge_method=${method}&bypass_requirements=${String(bypass)}`;
}

/**
 * What GitHub's merge box sends to merge directly (a rebase carries no
 * commit): `merge` with `bypassBranchProtections`, or, for a pull request in
 * a stack, `enqueue_stack` with `mergeAction` and `bypassRules` as a string.
 */
export function mergeRequest(pullPath: string, submission: MergeSubmission, nonce: string): { readonly url: string; readonly init: RequestInit } {
  const body: Record<string, string | boolean> = submission.stacked
    ? { mergeAction: 'DIRECT_MERGE', bypassRules: String(submission.bypass), mergeMethod: submission.method }
    : { bypassBranchProtections: submission.bypass, mergeMethod: submission.method };
  if (submission.method !== 'REBASE') {
    body.commitTitle = submission.commitTitle;
    body.commitMessage = submission.commitMessage;
  }
  if (submission.authorEmail !== null) body.authorEmail = submission.authorEmail;
  return { url: `${pullPath}/page_data/${submission.stacked ? 'enqueue_stack' : 'merge'}`, init: { method: 'POST', credentials: 'same-origin', headers: headers(nonce, true), body: JSON.stringify(body) } };
}

/** What GitHub's merge box sends to close the pull request: nothing but the request. */
export function closeRequest(pullPath: string, nonce: string): { readonly url: string; readonly init: RequestInit } {
  return { url: `${pullPath}/page_data/close_pull_request`, init: { method: 'POST', credentials: 'same-origin', headers: headers(nonce, false) } };
}

/** What GitHub's merge box sends to take a draft out of draft: nothing but the request (a body only carries Copilot's review effort). */
export function readyRequest(pullPath: string, nonce: string): { readonly url: string; readonly init: RequestInit } {
  return { url: `${pullPath}/page_data/mark_ready_for_review`, init: { method: 'POST', credentials: 'same-origin', headers: headers(nonce, false) } };
}

/** The reader's own standing verdict on the pull request, if they have one. */
export function viewerVerdict(box: MergeBox, login: string): ReviewVerdict['state'] | null {
  return box.verdicts.find((verdict) => verdict.login.toLowerCase() === login.toLowerCase())?.state ?? null;
}

function fetchNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="fetch-nonce"]')?.content ?? '';
}

/** The merge box for a method, or null when GitHub could not say. */
export async function fetchMergeBox(pullPath: string, method: MergeMethod, bypass: boolean): Promise<MergeBox | null> {
  try {
    const response = await fetch(mergeBoxUrl(pullPath, method, bypass), { credentials: 'same-origin', headers: headers(fetchNonce(), false) });
    if (!response.ok) return null;
    return parseMergeBox(await response.json());
  } catch {
    return null;
  }
}

export interface MergeActions {
  readonly box: MergeBox;
  readonly offer: MergeOffer;
}

/** What the reader may do now: the merge on offer and whether they may close, read with GitHub's default method. */
export async function readMergeActions(pullPath: string): Promise<MergeActions | null> {
  const first = await fetchMergeBox(pullPath, 'SQUASH', false);
  if (first === null) return null;
  const method = first.methods[0] ?? 'SQUASH';
  const box = method === 'SQUASH' ? first : ((await fetchMergeBox(pullPath, method, false)) ?? first);
  const asBypass = !box.mergeable && box.canBypass ? await fetchMergeBox(pullPath, method, true) : null;
  return { box, offer: mergeOffer(box, asBypass) };
}

/** The reason a merge or close failed, in GitHub's words when it gave any. */
export function actionErrorText(action: 'merge' | 'close' | 'ready', status: number, payload: unknown): string {
  const verb = action === 'ready' ? 'mark the pull request ready for review' : `${action} the pull request`;
  if (isRecord(payload)) {
    const said = stringOf(payload.error).trim();
    const metadata = isRecord(payload.metadata) ? payload.metadata : {};
    const rules = Array.isArray(metadata.ruleErrors) ? metadata.ruleErrors.map((rule) => (isRecord(rule) ? stringOf(rule.message) : stringOf(rule))).filter((rule) => rule !== '') : [];
    const words = [said, ...rules].filter((word) => word !== '');
    if (words.length > 0) return `GitHub could not ${verb}: ${words.join(' ')}`;
  }
  return `GitHub could not ${verb} (HTTP ${status}).`;
}

/** Whether a merge answer says it went through (GitHub answers `{ status: "merged" }`, or `"failed"` with an error). */
export function mergeWentThrough(payload: unknown): boolean {
  return isRecord(payload) && payload.status !== 'failed' && payload.error === undefined;
}
