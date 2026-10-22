import { onRestore } from './teleport';

/**
 * A person's login from GitHub's link to them. Where the reader's GitHub
 * shows full names (an account setting, and some organisations' default),
 * the link reads "Connor Peet (connor4312)": the login is the profile the link
 * leads to (`/connor4312`), the user hovercard it carries
 * (`/users/connor4312/hovercard`), or the parenthesis after the name; an
 * App's as its name with `[bot]`. Null for a link that names nobody.
 */
export function loginOfLink(link: Element): string | null {
  const href = link.getAttribute('href') ?? '';
  // An App's link names the App (`/apps/dependabot`, "dependabot"): its login is the name with `[bot]`, as `authorOf` has it.
  const app = /^(?:https?:\/\/[^/]+)?\/apps\/([^/?#]+)/.exec(href)?.[1];
  if (app !== undefined) {
    const name = (link.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/^@/, '') || app;
    return /\[bot\]$/i.test(name) ? name : `${name}[bot]`;
  }
  const profile = /^(?:https?:\/\/[^/]+)?\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/?$/.exec(href)?.[1];
  if (profile !== undefined) return profile;
  const card = /^\/users\/([^/?#]+)\/hovercard/.exec(link.getAttribute('data-hovercard-url') ?? '')?.[1];
  if (card !== undefined) return decodeURIComponent(card);
  const text = (link.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/^@/, '');
  return /\(([A-Za-z0-9-]+)\)$/.exec(text)?.[1] ?? (text === '' ? null : text);
}

const PEOPLE = 'a.author, a[data-hovercard-type="user"], [data-test-selector="pr-timeline-events-actor-profile-link"], [data-hovercard-url^="/users/"]';

/**
 * Every person named in GitHub's nodes on loan to the panel reads as their
 * login, as Geld's own rows do: a text node "Name (login)" inside a link to
 * them becomes "login", and is put back when the nodes go home. GitHub's
 * hovercard stays on the link. The crawl reads people from their links'
 * targets (`loginOfLink`), so a node reads the same at home and on loan.
 */
export function showLogins(root: ParentNode): void {
  for (const person of root.querySelectorAll<HTMLElement>(PEOPLE)) {
    const login = loginOfLink(person);
    if (login === null) continue;
    const named = new RegExp(`^(\\s*)\\S.*? \\(${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)(\\s*)$`, 'i');
    const walker = document.createTreeWalker(person, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue;
      const match = named.exec(node.data);
      if (match === null) continue;
      const text = node;
      const before = text.data;
      text.data = `${match[1] ?? ''}${login}${match[2] ?? ''}`;
      onRestore(() => {
        text.data = before;
      });
    }
  }
}
