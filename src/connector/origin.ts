export function platformOrigin(origin: string, allowLocalHttp = false): string {
  const url = new URL(origin);
  if (
    (url.protocol !== 'https:' &&
      !(
        allowLocalHttp &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use the Envar HTTPS origin');
  return url.origin;
}
