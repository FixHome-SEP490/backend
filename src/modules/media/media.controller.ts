// src/modules/media/media.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs';
import { MediaService, UploadedMediaFile } from './media.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

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
  @ApiOperation({ summary: 'Upload an image file (Customer booking or general media)' })
  async uploadFile(@UploadedFile() file?: UploadedMediaFile) {
    const result = await this.mediaService.saveFile(file!);
    return { data: result };
  }

  @Get('files/:filename')
  @ApiOperation({ summary: 'Stream/view uploaded media file' })
  async getFile(@Param('filename') filename: string, @Res() res: Response) {
    const { filePath, mimeType } = this.mediaService.getFilePath(filename);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }
}
