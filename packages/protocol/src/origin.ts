/**
 * Return the browser/WHATWG canonical origin and reject values that smuggle
 * credentials, path, query, or fragment. Network reachability policy is a
 * separate server-side check; this helper is safe in browser bundles.
 */
export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("expected an origin URL without credentials, path, query, or fragment");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("expected an HTTP(S) origin");
  }
  return url.origin;
}
