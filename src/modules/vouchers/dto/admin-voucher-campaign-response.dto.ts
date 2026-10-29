import { ApiProperty } from '@nestjs/swagger';
import { VoucherCampaignState, VoucherKind } from '../voucher.types';
import { CustomerGeneralVoucherDto } from './customer-voucher-response.dto';

/** Admin response schema. JSON timestamps use ISO strings; internal transport uses Date. */
export class AdminVoucherCampaignDto extends CustomerGeneralVoucherDto {
  @ApiProperty({ enum: VoucherKind }) kind: VoucherKind;
  @ApiProperty({ enum: VoucherCampaignState }) status: VoucherCampaignState;
  @ApiProperty({ description: 'Chỉ true khi status=PUBLISHED; vẫn cần kiểm cửa sổ thời gian' }) active: boolean;
  @ApiProperty() autoCompensation: boolean;
  @ApiProperty({ minimum: 1 }) quota: number;
  @ApiProperty({ minimum: 0, description: 'Lượt đã thanh toán thành công, không phải số người lưu mã' }) redeemed: number;
  @ApiProperty({ minimum: 1 }) version: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: Date;
}
