import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { CLOUDINARY } from '../../shared/cloudinary';
import type { CloudinaryInstance, UploadApiResponse } from '../../shared/cloudinary';
import {
  detectImageMimeType,
  detectMediaMimeType,
  detectVideoMimeType,
  maxBytesFor,
  type ImageMimeType,
  type MediaKind,
  type VideoMimeType,
} from '../../shared/utils/media-signature';

export type ChatAttachmentFile = { buffer: Buffer; mimetype: string; size: number };
export type ChatAttachmentKind = MediaKind;
export type ChatAttachmentContent = { buffer: Buffer; mimeType: ImageMimeType | VideoMimeType };

const REF_PREFIX = 'cloudinary://chat-media/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Photos and short videos sent in a booking chat (PO 18/10/2026). Private like the
 * booking photos: Cloudinary "authenticated" objects under the conversation's folder,
 * fetched server side with a short-lived signed URL, so a message never carries a
 * link that works outside the thread.
 */
@Injectable()
export class ChatAttachmentStorage {
  constructor(@Optional() @Inject(CLOUDINARY) private readonly cloudinary: CloudinaryInstance | null) {}

  /** What the file is by its bytes: a jpeg/png/webp photo up to 10 MB or an mp4/mov/webm video up to 50 MB. */
  inspect(file?: ChatAttachmentFile): { kind: ChatAttachmentKind; mimeType: ImageMimeType | VideoMimeType } {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.size !== file.buffer.length) {
      throw new BadRequestException('Invalid chat attachment');
    }
    const detected = detectMediaMimeType(file.buffer, file.mimetype);
    if (!detected || file.size > maxBytesFor(detected.kind)) throw new BadRequestException('Invalid chat attachment');
    return detected;
  }

  async upload(conversationId: string, kind: ChatAttachmentKind, file: ChatAttachmentFile): Promise<string> {
    if (!UUID_PATTERN.test(conversationId)) throw new BadRequestException('Invalid chat attachment');
    const cld = this.getCloudinary();
    const publicId = `fixhome/chat-media/${conversationId.toLowerCase()}/${randomUUID()}`;
    try {
      await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cld.uploader.upload_stream(
          { public_id: publicId, resource_type: kind, type: 'authenticated', overwrite: false },
          (error, result) => (error || !result ? reject(error || new Error('Empty Cloudinary response')) : resolve(result)),
        );
        Readable.from(file.buffer).pipe(stream);
      });
      return `${REF_PREFIX}${kind}/${publicId}`;
    } catch {
      throw new ServiceUnavailableException('Chat attachment storage is unavailable');
    }
  }

  async download(reference: string, conversationId: string): Promise<ChatAttachmentContent> {
    const { kind, publicId } = this.parse(reference, conversationId);
    const cld = this.getCloudinary();
    const maxBytes = maxBytesFor(kind);
    try {
      const signedUrl = cld.url(publicId, {
        type: 'authenticated',
        sign_url: true,
        resource_type: kind,
        secure: true,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
      const response = await axios.get(signedUrl, {
        responseType: 'arraybuffer',
        maxContentLength: maxBytes,
        maxRedirects: 0,
        timeout: kind === 'video' ? 60000 : 15000,
      });
      const buffer = Buffer.from(response.data);
      const mimeType = kind === 'video' ? detectVideoMimeType(buffer) : detectImageMimeType(buffer);
      if (buffer.length === 0 || buffer.length > maxBytes || !mimeType) throw new Error('Invalid chat attachment response');
      return { buffer, mimeType };
    } catch {
      throw new ServiceUnavailableException('Chat attachment storage is unavailable');
    }
  }

  /** The reference must name this conversation's folder: a row can never point the proxy at another thread's file. */
  private parse(reference: string, conversationId: string): { kind: ChatAttachmentKind; publicId: string } {
    if (typeof reference !== 'string' || !reference.startsWith(REF_PREFIX)) throw new BadRequestException('Invalid chat attachment');
    const [kind, ...rest] = reference.slice(REF_PREFIX.length).split('/');
    const publicId = rest.join('/');
    const segments = rest;
    if (
      (kind !== 'image' && kind !== 'video') ||
      segments.length !== 4 ||
      segments[0] !== 'fixhome' ||
      segments[1] !== 'chat-media' ||
      segments[2] !== String(conversationId).toLowerCase() ||
      !UUID_PATTERN.test(segments[3])
    ) {
      throw new BadRequestException('Invalid chat attachment');
    }
    return { kind, publicId };
  }

  private getCloudinary(): CloudinaryInstance {
    if (!this.cloudinary) throw new ServiceUnavailableException('Chat attachment storage is not configured');
    return this.cloudinary;
  }
}
