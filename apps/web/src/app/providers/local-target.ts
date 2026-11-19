export const SIGN_IN = '/sign-in';

/**
 * Resolved the way the browser will resolve it, so tabs or backslashes cannot point it at another origin. The result is
 * checked again: `/..//host` resolves on this origin to the path `//host`, which the router reads as another host.
 */
export function localTarget(next: string | null, origin: string): string {
  if (!next?.startsWith('/')) return '/';
  try {
    const url = new URL(next, origin);
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (url.origin !== origin || url.pathname === SIGN_IN || new URL(target, origin).origin !== origin) return '/';
    return target;
  } catch {
    return '/';
  }
}
