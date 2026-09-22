// src/modules/media/media.controller.ts
import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { MediaService, UploadedMediaFile } from './media.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { PrivateBookingPhotoUploadService } from './private-booking-photo-upload.service';
import { PrivateBookingPhotoFile } from './private-booking-photo-storage.service';

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly privateBookingPhotoUploadService: PrivateBookingPhotoUploadService,
  ) {}

  @Post('booking-photo-upload')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Customer: Upload a private Booking photo' })
  async uploadBookingPhoto(
    @CurrentUser('id') ownerUserId: string,
    @CurrentUser('role') role: Role,
    @UploadedFile() file?: PrivateBookingPhotoFile,
  ) {
    const result = await this.privateBookingPhotoUploadService.upload(
      role,
      ownerUserId,
      file,
    );
    return { data: result };
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload an image file to Supabase public storage' })
  async uploadFile(@UploadedFile() file?: UploadedMediaFile) {
    const result = await this.mediaService.saveFile(file!);
    return { data: result };
  }
}
