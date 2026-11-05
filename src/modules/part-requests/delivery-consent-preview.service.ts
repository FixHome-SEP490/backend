import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DeliveryConsentFactsService } from './delivery-consent-facts.service';

/** Read adapter only. Never mount B1 storage or use preview to authorize a command. */
@Injectable()
export class DeliveryConsentPreviewService {
  private readonly facts = new DeliveryConsentFactsService();

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async preview(id: string, actor: unknown) {
    // B2a's denial is a plain Error sentinel. Preserve DB exceptions by identity,
    // even if a driver happens to return the same message. Only read methods are exposed.
    let readFailed = false;
    const manager = this.dataSource.manager;
    const readOnly = {
      findOne: async (...args: Parameters<EntityManager['findOne']>) => {
        try {
          return await manager.findOne(...args);
        } catch (error) {
          readFailed = true;
          throw error;
        }
      },
      existsBy: async (...args: Parameters<EntityManager['existsBy']>) => {
        try {
          return await manager.existsBy(...args);
        } catch (error) {
          readFailed = true;
          throw error;
        }
      },
    };
    try {
      return await this.facts.preview(readOnly as EntityManager, id, actor);
    } catch (error) {
      if (
        !readFailed &&
        error instanceof Error &&
        error.constructor === Error &&
        error.message === 'NOT_FOUND_OR_DENIED'
      ) {
        throw new NotFoundException('Không tìm thấy yêu cầu.');
      }
      throw error;
    }
  }
}
