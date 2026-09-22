// src/modules/technician-assignment/technician-assignment.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TechnicianAssignmentController } from './technician-assignment.controller';
import { TechnicianAssignmentService } from './technician-assignment.service';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TechnicianAssignment,
      ServiceOrder,
      User,
      TechnicianProfile,
      Booking,
      BookingInvitation,
    ]),
    MessagingModule,
  ],
  controllers: [TechnicianAssignmentController],
  providers: [TechnicianAssignmentService],
  exports: [TechnicianAssignmentService],
})
export class TechnicianAssignmentModule {}
