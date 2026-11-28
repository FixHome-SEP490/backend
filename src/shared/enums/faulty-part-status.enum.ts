// src/shared/enums/faulty-part-status.enum.ts
/** Where one warranty part line's faulty units are: counted in at the warehouse, sent to the manufacturer, judged by it. */
export enum FaultyPartStatus {
  AWAITING = 'awaiting',
  PARTIAL = 'partial',
  RECEIVED = 'received',
  SENT_TO_MANUFACTURER = 'sent_to_manufacturer',
  MANUFACTURER_ACCEPTED = 'manufacturer_accepted',
  MANUFACTURER_REJECTED = 'manufacturer_rejected',
}
