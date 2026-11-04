import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsModule } from '../bookings/bookings.module';
import { VisitGroupsModule } from '../visit-groups/visit-groups.module';
import { Address } from '../users/entities/address.entity';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { BookingDraft } from './entities/booking-draft.entity';
import { BookingDraftSubmitReceipt } from './entities/booking-draft-submit-receipt.entity';
import { BookingDraftsController } from './booking-drafts.controller';
import { BookingDraftsService } from './booking-drafts.service';

@Module({
  imports: [BookingsModule, VisitGroupsModule,
    TypeOrmModule.forFeature([BookingDraft, BookingDraftSubmitReceipt, Address, PrivateBookingPhotoUpload])],
  controllers: [BookingDraftsController],
  providers: [BookingDraftsService],
})
export class BookingDraftsModule {}
