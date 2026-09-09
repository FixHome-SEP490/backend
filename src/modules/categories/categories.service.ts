// src/modules/categories/categories.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceCategory } from './entities/category.entity';
import { CreateCategoryDto, UpdateCategoryDto } from './dto';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(ServiceCategory)
    private readonly categoryRepository: Repository<ServiceCategory>,
  ) {}

  async findAll(onlyActive = true): Promise<ServiceCategory[]> {
    const where = onlyActive ? { isActive: true } : {};
    return this.categoryRepository.find({
      where,
      order: { name: 'ASC' },
    });
  }

  async findById(id: string, onlyActive = false): Promise<ServiceCategory> {
    const category = await this.categoryRepository.findOne({
      where: onlyActive ? { id, isActive: true } : { id },
      relations: ['services'],
    });

    if (!category) {
      throw new NotFoundException(`Service category with ID ${id} not found`);
    }

    if (onlyActive)
      category.services = category.services.filter(
        (service) => service.isActive,
      );
    return category;
  }

  async create(dto: CreateCategoryDto): Promise<ServiceCategory> {
    const code = dto.code.trim().toUpperCase();

    const existing = await this.categoryRepository.findOne({
      where: { code },
    });
    if (existing) {
      throw new ConflictException(`Category code ${code} is already in use`);
    }

    const category = this.categoryRepository.create({
      name: dto.name.trim(),
      code,
      description: dto.description?.trim() || null,
      isActive: dto.isActive !== undefined ? dto.isActive : true,
    });

    return this.categoryRepository.save(category);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<ServiceCategory> {
    const category = await this.findById(id);

    if (dto.name !== undefined) {
      category.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      category.description = dto.description?.trim() || null;
    }
    if (dto.isActive !== undefined) {
      category.isActive = dto.isActive;
    }

    return this.categoryRepository.save(category);
  }

  async toggleStatus(id: string, isActive: boolean): Promise<ServiceCategory> {
    const category = await this.findById(id);
    category.isActive = isActive;
    return this.categoryRepository.save(category);
  }
}
