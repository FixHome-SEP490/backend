import { IsString, IsUUID, Length, Matches } from 'class-validator';

export class WarehouseCommandDto {
  @IsUUID() idempotencyKey: string;
}
export class WarehouseHandoverDto extends WarehouseCommandDto {
  @IsString() @Length(64, 64) @Matches(/^[a-f0-9]{64}$/) qrToken: string;
}
