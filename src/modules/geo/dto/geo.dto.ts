import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class AutocompleteQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  input: string;

  /** Where to look first (the user's position or map centre); TP Hồ Chí Minh when absent. */
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;
}

export class ReverseGeocodeQueryDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}

export class PlaceSuggestionDto {
  @ApiProperty() placeId: string;
  @ApiProperty() description: string;
  @ApiProperty() lat: number;
  @ApiProperty() lng: number;
  @ApiProperty({ required: false }) ward?: string;
  @ApiProperty({ required: false }) district?: string;
  @ApiProperty({ required: false }) province?: string;
}

export class PlaceLocationDto {
  @ApiProperty() lat: number;
  @ApiProperty() lng: number;
  @ApiProperty() formattedAddress: string;
  @ApiProperty({ required: false }) ward?: string;
  @ApiProperty({ required: false }) district?: string;
  @ApiProperty({ required: false }) province?: string;
}
