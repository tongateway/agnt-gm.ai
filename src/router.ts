// router.ts — hash routes. The app is served under /app and routes on the
// hash, so a reload lands on the same screen and the worker needs no rewrite.
//   #/                 Home (idea box + my bots)
//   #/discover         Discover
//   #/bots/<id>        Bot (chat-first; draft, building, live and rejected)
//   #/bots/<id>/env    Keys
//   #/bots/<id>/plan   Plan
// Legacy hashes redirect: #/build/<id> → #/bots/<id>; #/bots → #/;
// #/bots/<id>/(chat|activity|board|taskboard|inbox) → #/bots/<id>.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'discover' }
  | { name: 'bot'; id: string }
  | { name: 'env'; id: string }
  | { name: 'plan'; id: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'discover') return { name: 'discover' };
  const id = parts[1] ? decodeURIComponent(parts[1]) : '';
  if ((parts[0] === 'bots' || parts[0] === 'build') && id) {
    if (parts[2] === 'env') return { name: 'env', id };
    if (parts[2] === 'plan') return { name: 'plan', id };
    return { name: 'bot', id };
  }
  return { name: 'home' };
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'home': return '#/';
    case 'discover': return '#/discover';
    case 'bot': return `#/bots/${encodeURIComponent(r.id)}`;
    case 'env': return `#/bots/${encodeURIComponent(r.id)}/env`;
    case 'plan': return `#/bots/${encodeURIComponent(r.id)}/plan`;
  }
}

// The screen "behind" a route — what Back goes to. Bot → Home; Keys/Plan → Bot.
export function parentRoute(r: Route): Route | null {
  switch (r.name) {
    case 'bot': return { name: 'home' };
    case 'env': case 'plan': return { name: 'bot', id: r.id };
    default: return null;
  }
}

function depth(r: Route): number {
  return r.name === 'home' || r.name === 'discover' ? 0 : r.name === 'bot' ? 1 : 2;
}

// In-app history: the hashes BEHIND the current entry, as this app pushed (or
// watched the browser walk) them. Lets Back pop the real history entry when
// the previous one IS the parent screen, instead of pushing the parent again
// (Home → Bot → Back → Home → browser-Back landed on Bot).
let behind: string[] = [];
let current = location.hash || '#/';
let pushing: string | null = null;  // hash a navigate() just pushed
let replacing = false;              // a replaceState + synthetic hashchange

export function navigate(r: Route, replace = false): void {
  const h = routeHash(r);
  if (location.hash === h) return;
  if (replace) {
    replacing = true;
    history.replaceState(null, '', h);
    // replaceState fires no hashchange — nudge listeners by hand
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  pushing = h;
  location.hash = h;
}

// Back to `parent`: a real history.back() when that is the entry behind us
// (so the browser's own Back/Forward stays coherent), else a replace.
export function goBack(parent: Route): void {
  const h = routeHash(parent);
  if (behind.length && behind[behind.length - 1] === h) { history.back(); return; }
  navigate(parent, true);
}

function trackHashChange(): void {
  const h = location.hash || '#/';
  if (replacing) replacing = false;
  else if (pushing === h) { behind.push(current); pushing = null; }
  else if (behind.length && behind[behind.length - 1] === h) behind.pop(); // went back
  else behind.push(current); // browser forward / manual edit — the old entry is behind us
  current = h;
}

// Current route + the slide direction of the last change (+1 deeper, −1 back).
export function useHashRoute(): { route: Route; dir: number } {
  const [state, setState] = useState(() => ({ route: parseRoute(location.hash), dir: 1 }));
  useEffect(() => {
    // normalise legacy hashes once so the address bar shows the canonical form
    const canon = routeHash(parseRoute(location.hash));
    if (location.hash !== canon) { history.replaceState(null, '', canon); current = canon; }
    const onChange = () => {
      trackHashChange();
      setState(prev => {
        const route = parseRoute(location.hash);
        return { route, dir: depth(route) >= depth(prev.route) ? 1 : -1 };
      });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return state;
}
