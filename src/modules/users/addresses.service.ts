// src/modules/users/addresses.service.ts
import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address } from './entities/address.entity';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private readonly addressRepo: Repository<Address>,
  ) {}

  async findByUserId(userId: string): Promise<Address[]> {
    return this.addressRepo.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string): Promise<Address> {
    const address = await this.addressRepo.findOne({
      where: { id, userId },
    });
    if (!address) {
      throw new NotFoundException('Address not found');
    }
    return address;
  }

  async create(userId: string, dto: CreateAddressDto): Promise<Address> {
    if (dto.isDefault) {
      await this.clearDefault(userId);
    }

    // If this is the user's first address, make it default automatically
    const count = await this.addressRepo.count({ where: { userId } });
    const isDefault = count === 0 ? true : !!dto.isDefault;

    const resolved = resolveServiceArea({
      province: dto.province,
      district: dto.district,
      provinceCode: dto.provinceCode,
      districtCode: dto.districtCode,
    });

    const address = this.addressRepo.create({
      ...dto,
      province: resolved.provinceName,
      district: resolved.districtName,
      provinceCode: resolved.provinceCode,
      districtCode: resolved.districtCode,
      userId,
      isDefault,
    });

    return this.addressRepo.save(address);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateAddressDto,
  ): Promise<Address> {
    const address = await this.findOne(userId, id);

    if (dto.isDefault) {
      await this.clearDefault(userId);
    }

    const resolved = resolveServiceArea({
      province: dto.province || address.province,
      district: dto.district || address.district,
      provinceCode: dto.provinceCode || address.provinceCode,
      districtCode: dto.districtCode || address.districtCode,
    });

    Object.assign(address, {
      ...dto,
      province: resolved.provinceName,
      district: resolved.districtName,
      provinceCode: resolved.provinceCode,
      districtCode: resolved.districtCode,
    });
    return this.addressRepo.save(address);
  }

  async remove(userId: string, id: string): Promise<void> {
    const address = await this.findOne(userId, id);
    await this.addressRepo.remove(address);
  }

  private async clearDefault(userId: string): Promise<void> {
    await this.addressRepo.update({ userId, isDefault: true }, { isDefault: false });
  }
}
