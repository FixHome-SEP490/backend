// src/modules/services/parts.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartCatalog } from './entities/part-catalog.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Parts Catalog')
@Controller('parts')
export class PartsController {
  constructor(
    @InjectRepository(PartCatalog)
    private readonly partRepo: Repository<PartCatalog>,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List FixHome official parts catalog' })
  async getParts(
    @Query('serviceId') serviceId?: string,
    @Query('search') search?: string,
  ) {
    const qb = this.partRepo.createQueryBuilder('p')
      .where('p.is_active = true');

    if (serviceId) {
      qb.andWhere('(p.service_id = :serviceId OR p.service_id IS NULL)', { serviceId });
    }

    if (search) {
      qb.andWhere('(p.name ILIKE :search OR p.code ILIKE :search)', { search: `%${search}%` });
    }

    qb.orderBy('p.name', 'ASC');

    const parts = await qb.getMany();
    return {
      data: parts.map(p => ({
        id: p.id,
        code: p.code,
        name: p.name,
        serviceId: p.serviceId,
        price: Number(p.price),
        warrantyDays: p.warrantyDays,
        warrantyPolicy: p.warrantyPolicy,
        description: p.description,
      })),
    };
  }
}
