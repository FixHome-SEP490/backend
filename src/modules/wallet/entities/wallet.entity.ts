import { Column, Entity, Index, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

export const bigintTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null | undefined) => (value == null ? 0 : Number(value)),
};

@Entity('wallets')
@Index('idx_wallets_technician_id', ['technicianId'])
@Index('idx_wallets_balance', ['balance'])
export class Wallet extends BaseEntity {
  @Column({ name: 'technician_id', type: 'uuid', unique: true })
  technicianId: string;

  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'technician_id' })
  technician?: User;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  balance: number;
}
