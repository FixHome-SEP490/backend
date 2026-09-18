// src/modules/ai-diagnosis/dto/ai-contract.dto.ts
//
// The shapes the AI Service actually speaks. Copied from the running service's
// own openapi.json rather than from a specification document, because the two
// had already drifted once: this module used to post `imageUrl` and read
// `possibleProblems`, and the AI Service has never had either field. It
// answered 200 OK and the mapping quietly produced defaults, which looks
// exactly like a working integration until you read the numbers.
//
// Requests and responses are camelCase. The one exception lives on the AI side:
// its multipart upload endpoint takes snake_case. We do not use that endpoint -
// we send base64 as JSON - so nothing here needs snake_case.

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Hard ceilings enforced by the AI Service. Rejecting here saves a round trip. */
export const AI_MAX_IMAGES = 3;
export const AI_MAX_DESCRIPTION = 4000;

export class AnalyzeDto {
  @ApiProperty({
    description:
      'What the customer typed. May be an empty string when they only sent a photo.',
    example: 'may giat nha em khong vat, keu to luc quay',
  })
  @IsString()
  description: string;

  @ApiPropertyOptional({
    description:
      'Up to three images, each a data URI or bare base64 string. JPEG, PNG or WebP, at most 8 MiB once decoded.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AI_MAX_IMAGES)
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional({
    description:
      'Session id issued by a previous reply. Omit on the first message; echo it back afterwards so the assistant remembers the appliance and the symptoms.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Service category the customer came in from.' })
  @IsOptional()
  @IsString()
  categoryHint?: string;

  @ApiPropertyOptional({
    description:
      'Only set once a booking exists. Supplying it is what makes the diagnosis worth keeping; without it nothing is written to the database.',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class AskDto {
  @ApiProperty({
    description: 'A question in Vietnamese. No images on this route.',
    example: 've sinh may lanh bao nhieu tien',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_MAX_DESCRIPTION)
  question: string;

  @ApiPropertyOptional({ description: 'Same session contract as analyze.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Narrows retrieval to one appliance.' })
  @IsOptional()
  @IsString()
  deviceType?: string;
}

export interface AiDetectedDevice {
  deviceType: string;
  nameVi: string;
  confidence: number;
  source?: string | null;
  boundingBox?: Record<string, number> | null;
}

export interface AiSuspectedFault {
  faultCode: string;
  nameVi: string;
  confidence: number;
  source?: string | null;
}

/**
 * `serviceId` is ours, not the AI's: the AI knows catalogue codes, the mobile
 * app needs the primary key to start a booking. Every one of the twenty-one
 * codes the AI can return exists in the seeded catalogue, so this resolves.
 */
export interface AiRecommendedService {
  serviceCode: string;
  nameVi: string;
  serviceId?: string | null;
}

export interface AiPriceEstimate {
  min: number;
  /** Null means "the technician has to look first" - render it as "from min". */
  max?: number | null;
  currency: string;
  requiresAssessment: boolean;
}

export interface AiClarification {
  questionsVi: string[];
  serviceGroupCodes?: string[] | null;
}

export interface AiCitation {
  docId: string;
  titleVi: string;
  score: number;
}
