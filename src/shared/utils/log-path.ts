/**
 * A request path safe to write in logs and error bodies. A video viewing link
 * carries its short-lived grant in the path (a video element cannot send an
 * Authorization header), so anyone reading the logs could watch the video
 * until it expires: the grant is replaced with a placeholder.
 */
export function logPath(path: string): string {
  return String(path ?? '').replace(/\/stream\/[^/?#]+/g, '/stream/[link]');
}
