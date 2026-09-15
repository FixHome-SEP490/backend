// src/shared/enums/part-warranty-option.enum.ts
// Spec v1.4 D-14/D-16: TECHNICIAN Part default NO_WARRANTY;
// Customer can choose PAID_WARRANTY with fee + term.
// FIXHOME Part has INCLUDED warranty from catalog.
export enum PartWarrantyOption {
  NO_WARRANTY = 'no_warranty',
  INCLUDED = 'included',
  PAID_WARRANTY = 'paid_warranty',
}
