import type { Request, Response } from 'express';
import type { VideoStream } from './private-video.service';

/**
 * Pipes a video (or its poster) from storage to the viewer as it arrives: the
 * status (200, 206 for a byte range, 416), the length and range headers, and a
 * private cache of ten minutes so replaying or seeking back on a weak connection
 * does not download the same bytes again. Storage is released as soon as the
 * viewer goes away.
 */
export function sendVideoStream(request: Request, response: Response, stream: VideoStream): void {
  response.status(stream.status);
  for (const [name, value] of Object.entries(stream.headers)) response.setHeader(name, value);
  response.setHeader('Cache-Control', 'private, max-age=600');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (stream.processing) response.setHeader('X-Video-Processing', '1');
  const release = () => stream.body.destroy();
  request.on('close', release);
  stream.body.on('error', () => {
    if (!response.headersSent) response.status(502);
    response.destroy();
  });
  if (request.method === 'HEAD') {
    release();
    response.end();
    return;
  }
  stream.body.pipe(response);
}
