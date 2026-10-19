import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { PartCustodyService } from './part-custody.service';
import { PartReturnsController } from './part-returns.controller';

@Module({ imports: [RbacModule], controllers: [PartReturnsController], providers: [PartCustodyService], exports: [PartCustodyService] })
export class PartCustodyModule {}
