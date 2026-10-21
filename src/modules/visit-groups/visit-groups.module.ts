import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsModule } from '../bookings/bookings.module';
import { SupportCasesModule } from '../support-cases/support-cases.module';
import { VisitGroup } from './entities/visit-group.entity';
import { VisitGroupItem } from './entities/visit-group-item.entity';
import { VisitGroupsController } from './visit-groups.controller';
import { VisitGroupsService } from './visit-groups.service';

/** Up to three devices in one visit (PO 21/10/2026). Off until visit_group.enabled is true. */
@Module({
  imports: [TypeOrmModule.forFeature([VisitGroup, VisitGroupItem]), BookingsModule, SupportCasesModule],
  controllers: [VisitGroupsController],
  providers: [VisitGroupsService],
  exports: [VisitGroupsService],
})
export class VisitGroupsModule {}
