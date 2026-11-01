import { IsIn, IsUUID } from 'class-validator';
import { CannotContinueDto } from './technician-report.dto';

export class GroupContactQueryDto {
  @IsUUID('4') selectedOrderId: string;
}

export class GroupContactAttemptDto extends GroupContactQueryDto {
  @IsUUID('4') commandId: string;
  @IsIn(['CALL_ATTEMPT', 'IN_APP_NOTIFICATION']) kind: 'CALL_ATTEMPT' | 'IN_APP_NOTIFICATION';
}

export class GroupStopDto extends CannotContinueDto {
  @IsUUID('4') selectedOrderId: string;
  @IsIn(['customer_absent', 'customer_unreachable'])
  declare reasonCode: CannotContinueDto['reasonCode'];
}
