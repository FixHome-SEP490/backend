// src/modules/users/dto/update-profile.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MinLength,
  MaxLength,
  ValidateIf,
  IsUrl,
} from 'class-validator';
import { IsPersonName } from '../../../shared/validation/text.validators';
import { Trim, Phone } from '../../../shared/validation/input.transforms';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'Nguyen Van B',
    description: 'Updated full name',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @Trim()
  @MaxLength(200)
  @IsString()
  @MinLength(2, { message: 'fullName must be at least 2 characters long' })
  @IsPersonName()
  fullName?: string;

  @ApiPropertyOptional({
    example: '0987654321',
    description: 'Updated Vietnamese phone number',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @Phone()
  @IsString()
  @Matches(/^0[35789][0-9]{8}$/, {
    message: 'phoneNumber must be a valid Vietnamese phone number',
  })
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
    description: 'Updated avatar URL',
  })
  // A hosted image: a device path such as file:///... cannot be loaded by
  // anyone else.
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false }, { message: 'avatarUrl must be an http(s) URL' })
  avatarUrl?: string;
}

