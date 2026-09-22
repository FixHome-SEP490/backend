import { IsString, Matches } from 'class-validator';
import { ReasonDto } from '../service-orders/order-command.dto';

// Loose UUID-shaped check (8-4-4-4-12 hex) rather than strict @IsUUID().
// Some legacy seeded demo accounts (technicians/customers) carry ids with
// zeroed version/variant nibbles, which @IsUUID() rejects as not RFC4122
// compliant even though they are real, unique primary keys in the DB.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidShaped = () => Matches(UUID_SHAPE, { message: 'must be a UUID-shaped id' });

export class AssignByTechnicianDto extends ReasonDto { @IsString() @uuidShaped() orderId: string; }
export class AssignByOrderDto extends ReasonDto { @IsString() @uuidShaped() technicianId: string; }
export class AssignByBookingDto extends ReasonDto { @IsString() @uuidShaped() technicianId: string; }
