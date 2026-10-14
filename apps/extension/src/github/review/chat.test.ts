// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { messagesIn } from './chat';

/**
 * Two shapes carry the `minimized-comment` class. A review's own body card
 * (`pullrequestreview-N`, "X left a comment") is the `timeline-comment-group`
 * itself — header, body, edit form and reactions are its direct children —
 * and GitHub gives it the class whether or not the review is minimized; it
 * is the message. A comment that *is* minimized is a wrapper holding a
 * `<details>` (the "This comment has been minimized" summary, then GitHub's
 * compact card); the card inside is the message. Markup reduced from
 * github.com, Oct 2026.
 */

function parse(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const first = holder.firstElementChild;
  if (!(first instanceof HTMLElement)) throw new Error('fixture has no element');
  return first;
}

const REVIEW_CARD = `
<div id="pullrequestreview-5405048471" class="timeline-comment-group js-minimizable-comment-group js-targetable-element my-0 comment previewable-edit js-task-list-container js-comment timeline-comment--caret timeline-comment--caret-nw timeline-comment tmp-ml-n3 current-user minimized-comment">
  <div class="timeline-comment-header clearfix d-flex flex-row flex-items-start">
    <h3 class="f5 text-normal py-2"><div class="d-flex flex-items-center flex-wrap gap-1"><a class="author Link--primary text-bold" href="/apps/cursor">cursor</a> <span>left a comment</span></div></h3>
    <div class="d-flex flex-row-reverse flex-items-center flex-shrink-0 tmp-pl-3"><div class="timeline-comment-actions flex-shrink-0 d-flex flex-items-center"></div></div>
  </div>
  <div class="edit-comment-hide">
    <div class="js-minimize-comment d-none"><form class="js-timeline-comment-minimize d-md-inline-block d-flex"></form></div>
    <task-lists><div class="comment-body markdown-body js-comment-body soft-wrap user-select-contain d-block"><p>Reviewed. One note inline.</p></div></task-lists>
  </div>
  <form class="js-comment-update"></form>
  <div class="pr-review-reactions d-flex gap-1"><div class="comment-reactions just-bottom js-reactions-container js-reaction-buttons-container social-reactions reactions-container d-flex"></div></div>
</div>`;

const MINIMIZED_COMMENT = `
<div class="timeline-comment-group js-minimizable-comment-group js-targetable-element my-0" id="issuecomment-5840397524">
  <div class="minimized-comment position-relative js-comment">
    <details class="Details-element details-reset">
      <summary class="btn-link text-small text-italic"><span>This comment has been minimized.</span></summary>
      <div class="review-comment-contents js-suggested-changes-contents">
        <div class="timeline-comment-header clearfix d-flex"><h3 class="f5 text-normal"><a class="author Link--primary text-bold" href="/apps/github-actions">github-actions</a> commented</h3></div>
        <div class="edit-comment-hide"><task-lists><div class="comment-body markdown-body js-comment-body d-block"><p>Build cache report: 12 hits.</p></div></task-lists></div>
      </div>
    </details>
  </div>
</div>`;

describe('messagesIn', () => {
  it("reads a review's own body card as the message, minimized-comment class and all", () => {
    const card = parse(REVIEW_CARD);
    const messages = messagesIn(card, false);
    expect(messages).toEqual([card]);
    // The header is the card's own child, so it is a part of the message (dressed as its author line), not a
    // bubble of its own: nothing inside the card is a message.
    expect(messages[0]?.querySelector('.timeline-comment-header')?.parentElement).toBe(card);
  });

  it("leaves a minimized comment's wrapper alone and reads the card inside its details", () => {
    const group = parse(MINIMIZED_COMMENT);
    const wrapper = group.querySelector<HTMLElement>('.minimized-comment');
    const inner = group.querySelector<HTMLElement>('.review-comment-contents');
    expect(wrapper).not.toBeNull();
    expect(inner).not.toBeNull();
    expect(messagesIn(group, false)).toEqual([inner]);
    // Handed the wrapper itself (the node the panel moves), the same card is the message.
    if (wrapper !== null) expect(messagesIn(wrapper, false)).toEqual([inner]);
  });

  it('reads the details element itself as the wrapper when GitHub puts the class on it', () => {
    const group = parse(MINIMIZED_COMMENT);
    const wrapper = group.querySelector<HTMLElement>('.minimized-comment');
    const details = group.querySelector<HTMLElement>('details');
    if (wrapper === null || details === null) throw new Error('fixture lost its parts');
    details.classList.add('minimized-comment', 'js-comment');
    wrapper.replaceWith(details);
    expect(messagesIn(group, false)).toEqual([group.querySelector('.review-comment-contents')]);
  });
});
