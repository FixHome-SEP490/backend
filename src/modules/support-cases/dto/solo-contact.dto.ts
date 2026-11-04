import { IsIn, IsUUID } from 'class-validator';

export class SoloContactAttemptDto {
  @IsUUID('4') commandId: string;
  @IsIn(['CALL_ATTEMPT', 'IN_APP_NOTIFICATION']) kind: 'CALL_ATTEMPT' | 'IN_APP_NOTIFICATION';
}
