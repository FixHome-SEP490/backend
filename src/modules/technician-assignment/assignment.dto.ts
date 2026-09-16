import { IsUUID } from 'class-validator';
import { ReasonDto } from '../service-orders/order-command.dto';
export class AssignByTechnicianDto extends ReasonDto { @IsUUID() orderId: string; }
export class AssignByOrderDto extends ReasonDto { @IsUUID() technicianId: string; }
