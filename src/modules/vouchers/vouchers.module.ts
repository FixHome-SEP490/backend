import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { VOUCHER_ENTITIES } from './entities/voucher.entity';
import { VoucherEvidence } from './voucher.ports';
import { RepairFailureVoucherEvidence } from './repair-failure-voucher-evidence';
import { VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';

/** Checkout, settlement and release stay fail closed; only persisted repair failure is verified. */
@Module({
  imports: [
    TypeOrmModule.forFeature(VOUCHER_ENTITIES),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
  ],
  controllers: [VouchersController],
  providers: [
    VouchersService,
    { provide: VoucherEvidence, useClass: RepairFailureVoucherEvidence },
  ],
  exports: [VouchersService],
})
export class VouchersModule {}
