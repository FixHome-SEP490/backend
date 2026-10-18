import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CHAT_EVENTS, MessagingGateway } from './messaging.gateway';

/** The channel migration 038's triggers notify on. */
export const REALTIME_CHANNEL = 'fixhome_changes';

/** Notices that arrive this close together are announced as one batch per record. */
export const REALTIME_FLUSH_MS = 120;
const MAX_BUFFERED = 500;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** A connection that stayed up this long starts its next retry from the first delay again. */
const STABLE_MS = 60_000;
/**
 * The listener sends itself a ping this often and must hear it before the next one,
 * otherwise it reconnects: a LISTEN behind the transaction pooler (Supabase 6543)
 * or a socket a NAT dropped answers queries but never delivers a notice.
 */
export const REALTIME_HEARTBEAT_MS = 20_000;
/** Screens are told to read everything again at most this often, however often the connection flaps. */
export const REALTIME_RESYNC_GAP_MS = 30_000;
const TRANSACTION_POOLER_PORT = 6543;
const PING = '_ping';

/** One NOTIFY payload, as the trigger writes it: the table, the operation and the row's ids. */
export interface ChangeNotice {
  t: string;
  op?: 'insert' | 'update' | 'delete';
  id?: string;
  so?: string;
  b?: string;
  u?: string;
  tech?: string;
  w?: string;
  /** Only the technician's position moved on this service order. */
  loc?: boolean;
}

/** What part of an order screen a change touches, so it reads only that again. */
export type OrderChangeKind =
  | 'order'
  | 'status'
  | 'invoice'
  | 'quotation'
  | 'additional_cost'
  | 'cash'
  | 'evidence'
  | 'arrival'
  | 'part'
  | 'warranty'
  | 'assignment';

const ORDER_KIND: Record<string, OrderChangeKind> = {
  service_orders: 'order',
  order_status_history: 'status',
  invoices: 'invoice',
  quotations: 'quotation',
  additional_cost_requests: 'additional_cost',
  cash_settlements: 'cash',
  repair_evidences: 'evidence',
  arrival_check_ins: 'arrival',
  part_requests: 'part',
  warranty_claims: 'warranty',
  technician_assignments: 'assignment',
};

export interface ChangeBatch {
  orders: Map<string, Set<OrderChangeKind>>;
  /** A technician who just lost or got an order also sees it change. */
  orderTechnicians: Map<string, Set<string>>;
  locations: Set<string>;
  bookings: Set<string>;
  invitations: Set<string>;
  notifications: Set<string>;
  technicianWallets: Set<string>;
  customerWallets: Set<string>;
}

const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => map.set(key, (map.get(key) ?? new Set<V>()).add(value));

/** Groups raw notices by the record a screen shows, so a burst of rows becomes one event per record. */
export function groupChanges(notices: ChangeNotice[]): ChangeBatch {
  const batch: ChangeBatch = {
    orders: new Map(),
    orderTechnicians: new Map(),
    locations: new Set(),
    bookings: new Set(),
    invitations: new Set(),
    notifications: new Set(),
    technicianWallets: new Set(),
    customerWallets: new Set(),
  };
  for (const notice of notices) {
    switch (notice.t) {
      case 'service_orders':
        if (!notice.id) break;
        if (notice.loc) {
          batch.locations.add(notice.id);
        } else {
          add(batch.orders, notice.id, notice.op === 'insert' ? 'status' : 'order');
        }
        // A new order means the customer's booking was taken.
        if (notice.op === 'insert' && notice.b) batch.bookings.add(notice.b);
        break;
      case 'bookings':
        if (notice.id) batch.bookings.add(notice.id);
        break;
      case 'booking_invitations':
        if (notice.id) batch.invitations.add(notice.id);
        if (notice.b) batch.bookings.add(notice.b);
        break;
      case 'notifications':
        if (notice.id && notice.op === 'insert') batch.notifications.add(notice.id);
        break;
      case 'wallets':
        if (notice.id) batch.technicianWallets.add(notice.id);
        break;
      case 'wallet_transactions':
        if (notice.w) batch.technicianWallets.add(notice.w);
        break;
      case 'customer_wallets':
        if (notice.id) batch.customerWallets.add(notice.id);
        break;
      case 'customer_wallet_transactions':
        if (notice.w) batch.customerWallets.add(notice.w);
        break;
      default: {
        const kind = ORDER_KIND[notice.t];
        if (!kind || !notice.so) break;
        add(batch.orders, notice.so, kind);
        // The technician named on an assignment or a warranty claim follows the order even when not its active one.
        if ((notice.t === 'technician_assignments' || notice.t === 'warranty_claims') && notice.tech) add(batch.orderTechnicians, notice.so, notice.tech);
      }
    }
  }
  return batch;
}

/** Parses one payload; anything that is not a notice from our trigger is ignored. */
export function parseNotice(payload: string | undefined): ChangeNotice | null {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as ChangeNotice;
    return value && typeof value === 'object' && typeof value.t === 'string' ? value : null;
  } catch {
    return null;
  }
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;
  removeAllListeners(): void;
}
type PgClientFactory = (config: Record<string, unknown>) => PgClient;

const defaultClientFactory: PgClientFactory = (config) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as { Client: new (config: Record<string, unknown>) => PgClient };
  return new Client(config);
};

/**
 * Live updates for order, booking, invitation, notification and wallet screens
 * (PO 18/10/2026: realtime, not reloading).
 *
 * The database tells every backend instance about every committed write (see
 * migration 038), whichever instance or code path made it, so a customer on one
 * server sees what a technician did through another. This listener keeps one
 * connection on `LISTEN`, groups what arrives within a moment, reads who may
 * see each record and what it now is, and sends each person a small event.
 *
 * Reconnects by itself with backoff. Changes made while it was away cannot be
 * replayed, so after a reconnect every open screen is told to read once again.
 */
@Injectable()
export class RealtimeChangeListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeChangeListener.name);
  private client: PgClient | null = null;
  private stopped = false;
  private everConnected = false;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** The ping this instance is waiting to hear back, if any. */
  private pendingPing: string | null = null;
  private connectedAt: number | null = null;
  private lastResyncAt = 0;
  private buffer: ChangeNotice[] = [];
  private createClient: PgClientFactory = defaultClientFactory;

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: MessagingGateway,
  ) {}

  /** Tests swap the connection for a fake. */
  useClientFactory(factory: PgClientFactory): void {
    this.createClient = factory;
  }

  onApplicationBootstrap(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.stopHeartbeat();
    this.retryTimer = null;
    this.flushTimer = null;
    this.resyncTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      // A socket error while closing must not become an unhandled 'error' event.
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }

  get listening(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const options = this.dataSource.options as Record<string, unknown> & { type?: string };
    if (options.type !== 'postgres' || !options.host) return;
    if (Number(options.port) === TRANSACTION_POOLER_PORT && !this.everConnected) {
      this.logger.warn('Live updates need a session connection: port 6543 is the transaction pooler, where LISTEN hears nothing. Use the session pooler (5432) or a direct connection.');
    }
    const client = this.createClient({
      host: options.host,
      port: options.port,
      user: options.username,
      password: options.password,
      database: options.database,
      ssl: options.ssl,
      keepAlive: true,
      // Notice a dropped idle socket in seconds, not the system default of two hours.
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'fixhome-realtime',
    });
    let lost = false;
    const onLost = (error?: unknown) => {
      if (lost) return;
      lost = true;
      this.handleLost(client, error);
    };
    client.on('notification', (message) => {
      if (message.channel === REALTIME_CHANNEL) this.receive(message.payload);
    });
    client.on('error', onLost);
    client.on('end', () => onLost());
    try {
      await client.connect();
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
    } catch (error) {
      onLost(error);
      return;
    }
    if (lost || this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.connectedAt = Date.now();
    this.logger.log(this.everConnected ? 'Live updates reconnected' : 'Listening for live updates');
    // Changes made while the connection was down were not heard: every open screen reads once.
    if (this.everConnected) this.requestResync();
    this.everConnected = true;
    this.startHeartbeat(client);
  }

  /** Tells every open screen to read once, at most once per REALTIME_RESYNC_GAP_MS (the last one is never dropped). */
  private requestResync(): void {
    if (this.resyncTimer) return;
    const wait = this.lastResyncAt + REALTIME_RESYNC_GAP_MS - Date.now();
    const send = () => {
      this.resyncTimer = null;
      if (this.stopped) return;
      this.lastResyncAt = Date.now();
      this.gateway.emitToEveryone(CHAT_EVENTS.REALTIME_RESYNC, { at: new Date().toISOString() });
    };
    if (wait <= 0) {
      send();
    } else {
      this.resyncTimer = setTimeout(send, wait);
      this.resyncTimer.unref?.();
    }
  }

  private startHeartbeat(client: PgClient): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.beat(client), REALTIME_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.pendingPing = null;
  }

  /** The previous ping must have come back; then the next one goes out through an ordinary pooled connection. */
  async beat(client: PgClient): Promise<void> {
    if (this.client !== client) return;
    if (this.pendingPing) {
      this.handleLost(client, new Error(`no notice heard for ${Math.round(REALTIME_HEARTBEAT_MS / 1000)}s`));
      return;
    }
    const ping = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingPing = ping;
    try {
      await this.dataSource.query('SELECT pg_notify($1, $2)', [REALTIME_CHANNEL, JSON.stringify({ t: PING, id: ping })]);
    } catch {
      // The database itself is unreachable: not this connection's fault, try again next beat.
      if (this.pendingPing === ping) this.pendingPing = null;
    }
  }

  private handleLost(client: PgClient, error?: unknown): void {
    if (this.client === client) {
      this.client = null;
      this.stopHeartbeat();
      // Only a connection that held for a while earns a quick retry; one that keeps dropping backs off.
      if (this.connectedAt !== null && Date.now() - this.connectedAt >= STABLE_MS) this.retryMs = RETRY_FIRST_MS;
      this.connectedAt = null;
    }
    client.removeAllListeners();
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.stopped || this.retryTimer) return;
    const reason = error instanceof Error ? error.message : 'connection closed';
    this.logger.warn(`Live updates paused (${reason}); retrying in ${Math.round(this.retryMs / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  /** One notice from the database; announced together with the others of the same moment. */
  receive(payload: string | undefined): void {
    const notice = parseNotice(payload);
    if (!notice) return;
    if (notice.t === PING) {
      // Our own ping came back (other instances' pings are not ours to answer).
      if (notice.id && notice.id === this.pendingPing) this.pendingPing = null;
      return;
    }
    this.buffer.push(notice);
    if (this.buffer.length >= MAX_BUFFERED) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), REALTIME_FLUSH_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const notices = this.buffer;
    this.buffer = [];
    if (notices.length) await this.publish(groupChanges(notices));
  }

  /** Reads each changed record and who may see it, then tells them. Best effort: a failure is logged, never thrown. */
  async publish(batch: ChangeBatch): Promise<void> {
    if (!this.gateway.server) return;
    const at = new Date().toISOString();
    await Promise.all([
      this.section('orders', () => this.publishOrders(batch, at)),
      this.section('locations', () => this.publishLocations(batch)),
      this.section('bookings', () => this.publishBookings(batch, at)),
      this.section('invitations', () => this.publishInvitations(batch, at)),
      this.section('notifications', () => this.publishNotifications(batch)),
      this.section('wallets', () => this.publishWallets(batch, at)),
    ]);
  }

  private async section(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`Live ${name} update not sent: ${(error as Error).message}`);
    }
  }

  private async publishOrders(batch: ChangeBatch, at: string): Promise<void> {
    const ids = [...batch.orders.keys()];
    if (!ids.length) return;
    const rows: Array<{ id: string; status: string; booking_id: string; customer_id: string; technician_ids: string[] | null }> =
      await this.dataSource.query(
        `SELECT so.id, so.status::text AS status, so.booking_id, b.customer_id,
                array_remove(array_agg(DISTINCT ta.technician_id), NULL) AS technician_ids
           FROM service_orders so
           JOIN bookings b ON b.id = so.booking_id
           -- A technician replaced on the order no longer follows it.
           LEFT JOIN technician_assignments ta ON ta.service_order_id = so.id AND ta.is_active = true
          WHERE so.id = ANY($1::uuid[])
          GROUP BY so.id, b.customer_id`,
        [ids],
      );
    const chatAffected: string[] = [];
    for (const row of rows) {
      const kinds = [...(batch.orders.get(row.id) ?? [])].sort();
      const recipients = [...new Set([row.customer_id, ...(row.technician_ids ?? []), ...(batch.orderTechnicians.get(row.id) ?? [])])];
      this.gateway.emitToUsers(recipients, CHAT_EVENTS.ORDER_UPDATED, {
        serviceOrderId: row.id,
        bookingId: row.booking_id,
        status: row.status,
        kinds,
        at,
      });
      // Whether the chat is open follows the order's status and its warranty claims.
      if (kinds.some((kind) => kind === 'status' || kind === 'order' || kind === 'warranty' || kind === 'assignment')) chatAffected.push(row.id);
    }
    if (!chatAffected.length) return;
    const threads: Array<{ id: string; customer_id: string; technician_id: string }> = await this.dataSource.query(
      `SELECT id, customer_id, technician_id FROM conversations WHERE service_order_id = ANY($1::uuid[])`,
      [chatAffected],
    );
    for (const thread of threads) this.gateway.emitConversationTouched([thread.customer_id, thread.technician_id], thread.id);
  }

  private async publishLocations(batch: ChangeBatch): Promise<void> {
    const ids = [...batch.locations];
    if (!ids.length) return;
    const rows: Array<{ id: string; customer_id: string; lat: string | null; lng: string | null; updated_at: Date | null }> =
      await this.dataSource.query(
        `SELECT so.id, b.customer_id, so.technician_last_lat AS lat, so.technician_last_lng AS lng,
                so.technician_location_updated_at AS updated_at
           FROM service_orders so
           JOIN bookings b ON b.id = so.booking_id
          WHERE so.id = ANY($1::uuid[]) AND so.status = 'en_route'`,
        [ids],
      );
    for (const row of rows) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (row.lat === null || row.lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Only the customer follows the technician on the map.
      this.gateway.emitToUsers([row.customer_id], CHAT_EVENTS.ORDER_LOCATION, {
        serviceOrderId: row.id,
        lat,
        lng,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      });
    }
  }

  private async publishBookings(batch: ChangeBatch, at: string): Promise<void> {
    const ids = [...batch.bookings];
    if (!ids.length) return;
    const rows: Array<{ id: string; status: string; customer_id: string; service_order_id: string | null }> = await this.dataSource.query(
      `SELECT b.id, b.status::text AS status, b.customer_id, so.id AS service_order_id
         FROM bookings b
         LEFT JOIN service_orders so ON so.booking_id = b.id
        WHERE b.id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows) {
      this.gateway.emitToUsers([row.customer_id], CHAT_EVENTS.BOOKING_UPDATED, {
        bookingId: row.id,
        status: row.status,
        serviceOrderId: row.service_order_id,
        at,
      });
    }
  }

  private async publishInvitations(batch: ChangeBatch, at: string): Promise<void> {
    const ids = [...batch.invitations];
    if (!ids.length) return;
    const rows: Array<{ id: string; booking_id: string; status: string; technician_id: string }> = await this.dataSource.query(
      `SELECT id, booking_id, status::text AS status, technician_id FROM booking_invitations WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows) {
      this.gateway.emitToUsers([row.technician_id], CHAT_EVENTS.INVITATION_UPDATED, {
        invitationId: row.id,
        bookingId: row.booking_id,
        status: row.status,
        at,
      });
    }
  }

  private async publishNotifications(batch: ChangeBatch): Promise<void> {
    const ids = [...batch.notifications];
    if (!ids.length) return;
    const rows: Array<{
      id: string;
      user_id: string;
      title: string;
      message: string;
      type: string;
      reference_id: string | null;
      reference_type: string | null;
      is_read: boolean;
      created_at: Date;
    }> = await this.dataSource.query(
      `SELECT id, user_id, title, message, type, reference_id, reference_type, is_read, created_at
         FROM notifications WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows) {
      // The person's own notification, in the shape GET /notifications returns it.
      this.gateway.emitToUsers([row.user_id], CHAT_EVENTS.NOTIFICATION_NEW, {
        id: row.id,
        title: row.title,
        message: row.message,
        type: row.type,
        referenceId: row.reference_id,
        referenceType: row.reference_type,
        isRead: row.is_read,
        createdAt: new Date(row.created_at).toISOString(),
      });
    }
  }

  private async publishWallets(batch: ChangeBatch, at: string): Promise<void> {
    if (batch.technicianWallets.size) {
      const rows: Array<{ technician_id: string }> = await this.dataSource.query(
        `SELECT technician_id FROM wallets WHERE id = ANY($1::uuid[])`,
        [[...batch.technicianWallets]],
      );
      this.gateway.emitToUsers(rows.map((row) => row.technician_id), CHAT_EVENTS.WALLET_UPDATED, { scope: 'technician', at });
    }
    if (batch.customerWallets.size) {
      const rows: Array<{ user_id: string }> = await this.dataSource.query(
        `SELECT user_id FROM customer_wallets WHERE id = ANY($1::uuid[])`,
        [[...batch.customerWallets]],
      );
      this.gateway.emitToUsers(rows.map((row) => row.user_id), CHAT_EVENTS.WALLET_UPDATED, { scope: 'customer', at });
    }
  }
}
