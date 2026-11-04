// src/shared/enums/part-request-type.enum.ts
export enum PartRequestType {
  PRE_REPAIR = 'pre_repair',
  QUOTATION = 'quotation',
  ADDITIONAL = 'additional',
  /** Free part for a warranty re-service; never invoiced to the customer (PO 04/11/2026). */
  WARRANTY = 'warranty',
}
