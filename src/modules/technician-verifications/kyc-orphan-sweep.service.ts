import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { startBackgroundJob } from '../../common/background-job';
import { KycStorageService } from './kyc-storage.service';

const SWEEP_BATCH = 100;
/** A signed upload URL lives 2h and a form may be filled slowly; never touch anything younger than a day. */
const MIN_AGE_HOURS = 24;

/**
 * Removes private KYC objects that no document row points to: leftovers of an upload
 * whose submit failed or was retried with a new object name.
 */
@Injectable()
export class KycOrphanSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KycOrphanSweepService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: KycStorageService,
  ) {}

  onModuleInit(): void {
    this.timer = startBackgroundJob('kyc orphan sweep', this.logger, async () => { await this.sweep(); });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    const bucket = process.env.SUPABASE_KYC_BUCKET?.trim() || 'kyc-private';
    const rows: { name: string }[] = await this.dataSource.query(
      `SELECT o.name FROM storage.objects o
        WHERE o.bucket_id = $1 AND o.name LIKE 'kyc/%'
          AND o.created_at < now() - make_interval(hours => $2)
          AND NOT EXISTS (SELECT 1 FROM verification_documents d WHERE d.storage_object_path = o.name)
          AND NOT EXISTS (SELECT 1 FROM customer_verification_documents c WHERE c.storage_object_path = o.name)
        ORDER BY o.created_at LIMIT $3`,
      [bucket, MIN_AGE_HOURS, SWEEP_BATCH],
    );
    await this.storage.remove(rows.map((r) => r.name));
    return rows.length;
  }
}
