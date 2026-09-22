// src/modules/bookings/bookings.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsController } from './bookings.controller';
import { InvitationsController } from './invitations.controller';
import { BookingsService } from './bookings.service';
import { BookingPrivateMediaContentService } from './booking-private-media-content.service';
import { InvitationsService } from './invitations.service';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingInvitationGroup } from './entities/booking-invitation-group.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { Address } from '../users/entities/address.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      BookingMedia,
      BookingInvitation,
      BookingInvitationGroup,
      User,
      Service,
      Address,
      TechnicianProfile,
      TechnicianSkill,
      TechnicianServiceArea,
    ]),
    MessagingModule,
    MediaModule,
  ],
  controllers: [BookingsController, InvitationsController],
  providers: [BookingsService, InvitationsService, BookingPrivateMediaContentService],
  exports: [BookingsService, InvitationsService],
})
export class BookingsModule {}
