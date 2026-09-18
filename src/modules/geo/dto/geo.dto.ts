import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AutocompleteQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  input: string;
}

export class GeocodeQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  placeId: string;
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
}

export class PlaceLocationDto {
  @ApiProperty() lat: number;
  @ApiProperty() lng: number;
  @ApiProperty() formattedAddress: string;
}
