import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AutocompleteQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  input: string;
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
