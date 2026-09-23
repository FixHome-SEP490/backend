import { createHmac, randomUUID } from 'crypto';

export interface VnpayBuildUrlInput {
  paymentUrl: string;
  tmnCode: string;
  hashSecret: string;
  amount: number;
  txnRef: string;
  orderInfo: string;
  returnUrl: string;
  ipAddr: string;
  createdAt?: Date;
}

function sortedQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+')}`)
    .join('&');
}

function sign(query: Record<string, string>, hashSecret: string): string {
  return createHmac('sha512', hashSecret)
    .update(Buffer.from(sortedQueryString(query), 'utf-8'))
    .digest('hex');
}

function formatVnpayDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function buildPaymentUrl(input: VnpayBuildUrlInput): string {
  const params: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: input.tmnCode,
    vnp_Amount: String(Math.round(input.amount * 100)),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: input.txnRef,
    vnp_OrderInfo: input.orderInfo,
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: input.returnUrl,
    vnp_IpAddr: input.ipAddr,
    vnp_CreateDate: formatVnpayDate(input.createdAt ?? new Date()),
  };
  const secureHash = sign(params, input.hashSecret);
  return `${input.paymentUrl}?${sortedQueryString(params)}&vnp_SecureHash=${secureHash}`;
}

/** Verifies vnp_SecureHash on an IPN/return query. Query values must be raw strings (not yet URL-decoded twice). */
export function verifySignature(
  query: Record<string, string>,
  hashSecret: string,
): boolean {
  const { vnp_SecureHash, vnp_SecureHashType: _ignored, ...rest } = query;
  if (!vnp_SecureHash) return false;
  const expected = sign(rest, hashSecret);
  return expected.toLowerCase() === vnp_SecureHash.toLowerCase();
}

export interface VnpayQueryDrInput {
  tmnCode: string;
  hashSecret: string;
  txnRef: string;
  orderInfo: string;
  transactionDate: Date;
  ipAddr: string;
  requestId?: string;
}

/**
 * Builds a signed "querydr" (transaction status query) request body for VNPay's
 * merchant_webapi/api/transaction endpoint — used to reconcile a payment when the
 * async IPN notification hasn't landed (e.g. localhost can't receive it in dev).
 * @see https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html
 */
export function buildQueryDrRequest(input: VnpayQueryDrInput): Record<string, string> {
  const requestId = input.requestId ?? randomUUID().replace(/-/g, '');
  const createDate = formatVnpayDate(new Date());
  const transactionDate = formatVnpayDate(input.transactionDate);
  const fields = [
    requestId,
    '2.1.0',
    'querydr',
    input.tmnCode,
    input.txnRef,
    transactionDate,
    createDate,
    input.ipAddr,
    input.orderInfo,
  ];
  const secureHash = createHmac('sha512', input.hashSecret)
    .update(Buffer.from(fields.join('|'), 'utf-8'))
    .digest('hex');
  return {
    vnp_RequestId: requestId,
    vnp_Version: '2.1.0',
    vnp_Command: 'querydr',
    vnp_TmnCode: input.tmnCode,
    vnp_TxnRef: input.txnRef,
    vnp_OrderInfo: input.orderInfo,
    vnp_TransactionDate: transactionDate,
    vnp_CreateDate: createDate,
    vnp_IpAddr: input.ipAddr,
    vnp_SecureHash: secureHash,
  };
}
