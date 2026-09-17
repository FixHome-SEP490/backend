import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const MESSAGE_MAX_LENGTH = 2000;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SendMessageDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  content: string;

  /** Optional echo key so the sender can dedupe its own optimistic bubble. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'clientMessageId must be alphanumeric, dash or underscore',
  })
  clientMessageId?: string;
}

export class EditMessageDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  content: string;
}

export class ListMessagesQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Keyset cursor: return messages strictly older than this ISO timestamp. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  before?: string;
}
