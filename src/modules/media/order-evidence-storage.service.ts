import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';

export type EvidenceFile = { buffer: Buffer; mimetype: string; size: number };

/** Private Supabase objects; only the order service may issue short-lived read URLs. */
@Injectable()
export class OrderEvidenceStorage {
  validate(file?: EvidenceFile): asserts file is EvidenceFile {
    if (!file?.buffer?.length || file.size !== file.buffer.length || file.size > 10 * 1024 * 1024) throw new BadRequestException('Select an image up to 10 MB');
    const bytes = file.buffer;
    const valid = (file.mimetype === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
      || (file.mimetype === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (file.mimetype === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
    if (!valid) throw new BadRequestException('Only JPEG, PNG and WebP image files are accepted');
  }

  private client() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_EVIDENCE_BUCKET;
    if (!url || !key || !bucket || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(url) || !/^[a-z0-9_-]+$/.test(bucket)) throw new ServiceUnavailableException('Private evidence storage is not configured');
    return { bucket, url: url.replace(/\/$/, ''), http: axios.create({ baseURL: `${url.replace(/\/$/, '')}/storage/v1`, timeout: 10000, maxRedirects: 0, headers: { apikey: key, Authorization: `Bearer ${key}` } }) };
  }

  async upload(orderId: string, ownerId: string, file: EvidenceFile): Promise<string> {
    this.validate(file);
    const { http, bucket } = this.client();
    const path = `${orderId}/${ownerId}/${randomUUID()}`;
    try {
      const info = await http.get(`/bucket/${bucket}`);
      if (info.data.public !== false) throw new Error('Evidence bucket must be private');
      await http.post(`/object/${bucket}/${path}`, file.buffer, { headers: { 'Content-Type': file.mimetype, 'x-upsert': 'false' }, maxBodyLength: 10 * 1024 * 1024 });
      return `storage://${bucket}/${path}`;
    } catch {
      // Do not expose provider responses, credentials or object paths to clients.
      throw new ServiceUnavailableException('Private evidence upload failed');
    }
  }

  async signedUrl(reference: string): Promise<string> {
    const { http, bucket, url } = this.client();
    if (!reference.startsWith(`storage://${bucket}/`)) throw new ServiceUnavailableException('Legacy evidence requires private storage migration');
    const path = reference.slice(`storage://${bucket}/`.length);
    if (!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/.test(path)) throw new ServiceUnavailableException('Invalid evidence reference');
    try {
      const result = await http.post(`/object/sign/${bucket}/${path}`, { expiresIn: 300 });
      const signed = result.data.signedURL;
      if (typeof signed !== 'string' || !signed.startsWith('/object/sign/')) throw new Error('Invalid signed URL');
      return `${url}/storage/v1${signed}`;
    } catch {
      throw new ServiceUnavailableException('Evidence access is temporarily unavailable');
    }
  }

  async delete(reference: string): Promise<void> {
    const { http, bucket } = this.client();
    if (!reference.startsWith(`storage://${bucket}/`)) return;
    const path = reference.slice(`storage://${bucket}/`.length);
    try {
      await http.delete(`/object/${bucket}`, { data: { prefixes: [path] } });
    } catch {
      // Non-blocking storage deletion
    }
  }
}

