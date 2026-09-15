// src/modules/bookings/entities/booking.entity.ts
import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';
import { Service } from '../../services/entities/service.entity';
import { Address } from '../../users/entities/address.entity';
import { BookingStatus, ServicePricingMode, UrgencyLevel } from '../../../shared/enums';
import { BookingMedia } from './booking-media.entity';
import { BookingInvitation } from './booking-invitation.entity';

@Entity('bookings')
@Index('ix_bookings_customer', ['customerId', 'createdAt'])
@Index('ix_bookings_status', ['status'])
export class Booking extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  @ManyToOne(() => Service, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Service;

  @Column({ name: 'address_id', type: 'uuid', nullable: true })
  addressId?: string | null;

  @ManyToOne(() => Address, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'address_id' })
  address?: Address | null;

  // Spec v1.4: Address snapshot so history doesn't change if customer edits address book
  @Column({ name: 'address_text_snapshot', type: 'text', nullable: true })
  addressTextSnapshot?: string | null;

  @Column({ name: 'province_snapshot', type: 'varchar', length: 100, nullable: true })
  provinceSnapshot?: string | null;

  @Column({ name: 'district_snapshot', type: 'varchar', length: 100, nullable: true })
  districtSnapshot?: string | null;

  @Column({ name: 'province_name_snapshot', type: 'varchar', length: 100, nullable: true })
  provinceNameSnapshot?: string | null;

  @Column({ name: 'district_name_snapshot', type: 'varchar', length: 100, nullable: true })
  districtNameSnapshot?: string | null;

  @Column({ name: 'service_name_snapshot', type: 'varchar', length: 255, nullable: true })
  serviceNameSnapshot?: string | null;

  @Column({ name: 'latitude_snapshot', type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitudeSnapshot?: number | null;

  @Column({ name: 'longitude_snapshot', type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitudeSnapshot?: number | null;

  @Column({ type: 'text' })
  description: string;

  // Spec v1.4: Customer chooses preferred time window (start + end), not exact arrival minute
  @Column({ name: 'preferred_start_at', type: 'timestamptz', nullable: true })
  preferredStartAt?: Date | null;

  @Column({ name: 'preferred_end_at', type: 'timestamptz', nullable: true })
  preferredEndAt?: Date | null;

  @Column({
    name: 'pricing_mode_snapshot',
    type: 'enum',
    enum: ServicePricingMode,
    nullable: true,
  })
  pricingModeSnapshot?: ServicePricingMode | null;

  @Column({
    name: 'fixed_unit_price_snapshot',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  fixedUnitPriceSnapshot?: number | null;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ name: 'scope_snapshot', type: 'text', nullable: true })
  scopeSnapshot?: string | null;

  @Column({
    type: 'enum',
    enum: UrgencyLevel,
    default: UrgencyLevel.MEDIUM,
  })
  urgency: UrgencyLevel;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.SUBMITTED,
  })
  status: BookingStatus;

  @OneToMany(() => BookingMedia, (m) => m.booking)
  media: BookingMedia[];

  @OneToMany(() => BookingInvitation, (inv) => inv.booking)
  invitations: BookingInvitation[];
}

