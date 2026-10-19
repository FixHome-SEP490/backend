import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_EVENTS } from './messaging.gateway';
import {
  groupChanges,
  parseNotice,
  REALTIME_CHANNEL,
  REALTIME_FLUSH_MS,
  REALTIME_HEARTBEAT_MS,
  REALTIME_RESYNC_GAP_MS,
  RealtimeChangeListener,
} from './realtime-change.listener';

const ORDER = '11111111-1111-4111-8111-111111111111';
const BOOKING = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = 'c0000000-0000-4000-8000-000000000001';
const TECH = 't0000000-0000-4000-8000-000000000001';
const OLD_TECH = 't0000000-0000-4000-8000-000000000002';

class FakeClient {
  handlers: Record<string, (...args: any[]) => void> = {};
  connect = vi.fn(async () => undefined);
  query = vi.fn(async (_sql: string) => undefined);
  end = vi.fn(async () => undefined);
  on(event: string, handler: (...args: any[]) => void) {
    this.handlers[event] = handler;
  }
  removeAllListeners() {
    this.handlers = {};
  }
  notify(payload: object | string) {
    this.handlers.notification?.({ channel: REALTIME_CHANNEL, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }
}

function setup(rows: Record<string, unknown[]> = {}) {
  const emitToUsers = vi.fn();
  const emitToEveryone = vi.fn();
  const emitConversationTouched = vi.fn();
  const gateway = { server: {}, emitToUsers, emitToEveryone, emitConversationTouched } as any;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    const key = Object.keys(rows).find((fragment) => sql.includes(fragment));
    return key ? rows[key] : [];
  });
  const dataSource = { options: { type: 'postgres', host: 'db', port: 5432, username: 'u', password: 'p', database: 'd', ssl: false }, query } as any;
  const listener = new RealtimeChangeListener(dataSource, gateway);
  const clients: FakeClient[] = [];
  const configs: Record<string, unknown>[] = [];
  listener.useClientFactory((config) => {
    configs.push(config);
    const client = new FakeClient();
    clients.push(client);
    return client;
  });
  return { listener, gateway, query, clients, configs, emitToUsers, emitToEveryone, emitConversationTouched };
}

const ORDER_ROW = { id: ORDER, status: 'en_route', booking_id: BOOKING, customer_id: CUSTOMER, technician_ids: [TECH] };

describe('groupChanges', () => {
  it('routes item usage and custody receipts to a targeted part refresh, including the original custodian', () => {
    const batch = groupChanges([
      { t: 'part_requests', op: 'update', id: 'request', so: ORDER },
      { t: 'part_request_items', op: 'update', id: 'item', so: ORDER },
      { t: 'part_custodies', op: 'update', id: 'custody', so: ORDER, tech: OLD_TECH },
    ]);
    expect([...batch.orders.get(ORDER)!]).toEqual(['part']);
    expect([...(batch.orderTechnicians.get(ORDER) ?? [])]).toEqual([OLD_TECH]);
  });
  it('turns rows into one entry per order with the kinds of change, and keeps a position move apart', () => {
    const batch = groupChanges([
      { t: 'order_status_history', op: 'insert', id: 'h1', so: ORDER },
      { t: 'quotations', op: 'update', id: 'q1', so: ORDER },
      { t: 'quotations', op: 'update', id: 'q1', so: ORDER },
      { t: 'service_orders', op: 'update', id: ORDER, b: BOOKING, loc: true },
      { t: 'technician_assignments', op: 'update', id: 'a1', so: ORDER, tech: OLD_TECH },
    ]);
    expect([...batch.orders.keys()]).toEqual([ORDER]);
    expect([...batch.orders.get(ORDER)!].sort()).toEqual(['assignment', 'quotation', 'status']);
    expect([...batch.locations]).toEqual([ORDER]);
    expect([...batch.orderTechnicians.get(ORDER)!]).toEqual([OLD_TECH]);
  });

  it('routes bookings, invitations, notifications and both kinds of wallet', () => {
    const batch = groupChanges([
      { t: 'service_orders', op: 'insert', id: ORDER, b: BOOKING },
      { t: 'booking_invitations', op: 'update', id: 'i1', b: BOOKING, tech: TECH },
      { t: 'notifications', op: 'insert', id: 'n1', u: CUSTOMER },
      { t: 'notifications', op: 'update', id: 'n2', u: CUSTOMER },
      { t: 'wallet_transactions', op: 'insert', id: 'wt1', w: 'w1' },
      { t: 'wallets', op: 'update', id: 'w2', tech: TECH },
      { t: 'customer_wallet_transactions', op: 'insert', id: 'ct1', w: 'cw1' },
      { t: 'unknown_table', op: 'insert', id: 'x', so: ORDER },
      { t: 'invoices', op: 'update', id: 'inv' },
    ]);
    expect([...batch.orders.get(ORDER)!]).toEqual(['status']);
    expect([...batch.bookings]).toEqual([BOOKING]);
    expect([...batch.invitations]).toEqual(['i1']);
    // Only a new notification is announced; marking one read is not news.
    expect([...batch.notifications]).toEqual(['n1']);
    expect([...batch.technicianWallets].sort()).toEqual(['w1', 'w2']);
    expect([...batch.customerWallets]).toEqual(['cw1']);
  });
});

describe('parseNotice', () => {
  it('accepts the trigger payload and ignores anything else', () => {
    expect(parseNotice('{"t":"bookings","op":"update","id":"b"}')).toEqual({ t: 'bookings', op: 'update', id: 'b' });
    for (const bad of [undefined, '', 'not json', '42', 'null', '{"op":"update"}']) expect(parseNotice(bad)).toBeNull();
  });
});

describe('RealtimeChangeListener', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('listens with the database settings, groups a burst and sends one event per order to the customer and technicians', async () => {
    const { listener, clients, configs, emitToUsers, emitConversationTouched } = setup({
      'FROM service_orders so': [ORDER_ROW],
      'FROM conversations': [{ id: 'conv', customer_id: CUSTOMER, technician_id: TECH }],
    });
    await listener.connect();
    expect(configs[0]).toMatchObject({ host: 'db', port: 5432, user: 'u', password: 'p', database: 'd', keepAlive: true });
    expect(clients[0].query).toHaveBeenCalledWith(`LISTEN ${REALTIME_CHANNEL}`);
    expect(listener.listening).toBe(true);

    clients[0].notify({ t: 'order_status_history', op: 'insert', id: 'h1', so: ORDER });
    clients[0].notify({ t: 'service_orders', op: 'update', id: ORDER, b: BOOKING });
    clients[0].notify('garbage');
    expect(emitToUsers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REALTIME_FLUSH_MS);

    expect(emitToUsers).toHaveBeenCalledTimes(1);
    const [recipients, event, payload] = emitToUsers.mock.calls[0];
    expect(recipients).toEqual([CUSTOMER, TECH]);
    expect(event).toBe(CHAT_EVENTS.ORDER_UPDATED);
    expect(payload).toMatchObject({ serviceOrderId: ORDER, bookingId: BOOKING, status: 'en_route', kinds: ['order', 'status'] });
    // The chat's open/closed state follows the order.
    expect(emitConversationTouched).toHaveBeenCalledWith([CUSTOMER, TECH], 'conv');
  });

  it('does not touch the chat for a change that cannot open or close it', async () => {
    const { listener, emitToUsers, emitConversationTouched, query } = setup({ 'FROM service_orders so': [ORDER_ROW] });
    await listener.publish(groupChanges([{ t: 'repair_evidences', op: 'insert', id: 'e1', so: ORDER }]));
    expect(emitToUsers.mock.calls[0][2]).toMatchObject({ kinds: ['evidence'] });
    expect(emitConversationTouched).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM conversations'))).toBe(false);
  });

  it('also tells a technician taken off the order', async () => {
    const { listener, emitToUsers } = setup({ 'FROM service_orders so': [ORDER_ROW] });
    await listener.publish(groupChanges([{ t: 'technician_assignments', op: 'update', id: 'a1', so: ORDER, tech: OLD_TECH }]));
    expect(emitToUsers.mock.calls[0][0]).toEqual([CUSTOMER, TECH, OLD_TECH]);
  });

  it('sends only the position to the customer while the technician is on the way', async () => {
    const { listener, emitToUsers } = setup({
      'technician_last_lat AS lat': [
        { id: ORDER, customer_id: CUSTOMER, lat: '10.7712', lng: '106.7001', updated_at: new Date('2026-10-18T01:00:00Z') },
        { id: 'other', customer_id: CUSTOMER, lat: null, lng: null, updated_at: null },
      ],
    });
    await listener.publish(groupChanges([{ t: 'service_orders', op: 'update', id: ORDER, loc: true }]));
    expect(emitToUsers).toHaveBeenCalledTimes(1);
    expect(emitToUsers).toHaveBeenCalledWith([CUSTOMER], CHAT_EVENTS.ORDER_LOCATION, {
      serviceOrderId: ORDER, lat: 10.7712, lng: 106.7001, updatedAt: '2026-10-18T01:00:00.000Z',
    });
  });

  it('sends booking, invitation, notification and wallet events only to their owners', async () => {
    const { listener, emitToUsers } = setup({
      'FROM bookings b': [{ id: BOOKING, status: 'matched', customer_id: CUSTOMER, service_order_id: ORDER }],
      'FROM booking_invitations': [{ id: 'i1', booking_id: BOOKING, status: 'accepted', technician_id: TECH }],
      'FROM notifications': [{ id: 'n1', user_id: TECH, title: 'T', message: 'M', type: 'INFO', reference_id: null, reference_type: null, is_read: false, created_at: new Date('2026-10-18T00:00:00Z') }],
      'FROM wallets': [{ technician_id: TECH }],
      'FROM customer_wallets': [{ user_id: CUSTOMER }],
    });
    await listener.publish(groupChanges([
      { t: 'bookings', op: 'update', id: BOOKING },
      { t: 'booking_invitations', op: 'update', id: 'i1', b: BOOKING },
      { t: 'notifications', op: 'insert', id: 'n1', u: TECH },
      { t: 'wallet_transactions', op: 'insert', id: 'wt', w: 'w1' },
      { t: 'customer_wallet_transactions', op: 'insert', id: 'ct', w: 'cw1' },
    ]));
    const sent = emitToUsers.mock.calls.map(([users, event, payload]) => ({ users, event, payload }));
    expect(sent).toContainEqual({ users: [CUSTOMER], event: CHAT_EVENTS.BOOKING_UPDATED, payload: expect.objectContaining({ bookingId: BOOKING, status: 'matched', serviceOrderId: ORDER }) });
    expect(sent).toContainEqual({ users: [TECH], event: CHAT_EVENTS.INVITATION_UPDATED, payload: expect.objectContaining({ invitationId: 'i1', bookingId: BOOKING, status: 'accepted' }) });
    expect(sent).toContainEqual({ users: [TECH], event: CHAT_EVENTS.NOTIFICATION_NEW, payload: { id: 'n1', title: 'T', message: 'M', type: 'INFO', referenceId: null, referenceType: null, isRead: false, createdAt: '2026-10-18T00:00:00.000Z' } });
    expect(sent).toContainEqual({ users: [TECH], event: CHAT_EVENTS.WALLET_UPDATED, payload: expect.objectContaining({ scope: 'technician' }) });
    expect(sent).toContainEqual({ users: [CUSTOMER], event: CHAT_EVENTS.WALLET_UPDATED, payload: expect.objectContaining({ scope: 'customer' }) });
  });

  it('keeps going when one kind of record cannot be read', async () => {
    const { listener, emitToUsers, query } = setup({ 'FROM bookings b': [{ id: BOOKING, status: 'matching', customer_id: CUSTOMER, service_order_id: null }] });
    query.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(listener.publish(groupChanges([
      { t: 'order_status_history', op: 'insert', id: 'h', so: ORDER },
      { t: 'bookings', op: 'update', id: BOOKING },
    ]))).resolves.toBeUndefined();
    expect(emitToUsers).toHaveBeenCalledWith([CUSTOMER], CHAT_EVENTS.BOOKING_UPDATED, expect.anything());
  });

  it('reconnects with growing pauses, then tells every screen to read again once', async () => {
    const { listener, clients, emitToEveryone } = setup();
    await listener.connect();
    expect(emitToEveryone).not.toHaveBeenCalled();

    clients[0].handlers.error(new Error('terminated'));
    expect(listener.listening).toBe(false);
    expect(clients[0].end).toHaveBeenCalled();

    // The first retry fails too, so the next waits longer.
    (listener as any).createClient = ((original) => (config: Record<string, unknown>) => {
      const client = original(config);
      if (clients.length === 2) client.connect.mockRejectedValueOnce(new Error('refused'));
      return client;
    })((listener as any).createClient);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    expect(listener.listening).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener.listening).toBe(true);
    expect(emitToEveryone).toHaveBeenCalledTimes(1);
    expect(emitToEveryone).toHaveBeenCalledWith(CHAT_EVENTS.REALTIME_RESYNC, expect.objectContaining({ at: expect.any(String) }));
  });

  it('stops for good on shutdown and never sends to nobody', async () => {
    const { listener, clients, emitToUsers } = setup({ 'FROM service_orders so': [ORDER_ROW] });
    await listener.connect();
    await listener.onModuleDestroy();
    expect(clients[0].end).toHaveBeenCalled();
    expect(listener.listening).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    // Without a socket server nothing is read or sent.
    const idle = setup();
    idle.gateway.server = undefined;
    await idle.listener.publish(groupChanges([{ t: 'order_status_history', op: 'insert', id: 'h', so: ORDER }]));
    expect(idle.query).not.toHaveBeenCalled();
    expect(emitToUsers).not.toHaveBeenCalled();
  });

  // Review 18/10/2026: a LISTEN that hears nothing (transaction pooler, dropped NAT) must not look healthy.
  it('pings itself and reconnects when its own ping never comes back', async () => {
    const { listener, clients, configs, query } = setup();
    await listener.connect();
    expect(configs[0]).toMatchObject({ keepAliveInitialDelayMillis: 10_000 });
    const pings = () => query.mock.calls.filter(([sql]) => String(sql).includes('pg_notify'));

    await vi.advanceTimersByTimeAsync(REALTIME_HEARTBEAT_MS);
    expect(pings()).toHaveLength(1);
    const [channel, payload] = pings()[0][1] as [string, string];
    expect(channel).toBe(REALTIME_CHANNEL);
    // Someone else's ping is not ours; ours coming back keeps the connection.
    clients[0].notify({ t: '_ping', id: 'another-instance' });
    clients[0].notify(JSON.parse(payload));
    await vi.advanceTimersByTimeAsync(REALTIME_HEARTBEAT_MS);
    expect(listener.listening).toBe(true);
    expect(pings()).toHaveLength(2);

    // The second ping is never heard: the connection is dropped and opened again.
    await vi.advanceTimersByTimeAsync(REALTIME_HEARTBEAT_MS);
    expect(listener.listening).toBe(false);
    expect(clients[0].end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    expect(listener.listening).toBe(true);
    await listener.onModuleDestroy();
  });

  it('a ping is never announced to anyone, and a database outage during a ping is not blamed on the connection', async () => {
    const { listener, clients, query, emitToUsers } = setup();
    await listener.connect();
    query.mockImplementationOnce(async () => { throw new Error('db down'); });
    await vi.advanceTimersByTimeAsync(REALTIME_HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(REALTIME_HEARTBEAT_MS);
    expect(listener.listening).toBe(true);
    clients[0].notify({ t: '_ping', id: 'x' });
    await vi.advanceTimersByTimeAsync(REALTIME_FLUSH_MS);
    expect(emitToUsers).not.toHaveBeenCalled();
    await listener.onModuleDestroy();
  });

  it('a connection that keeps dropping backs off and tells screens to read again at most every 30 seconds', async () => {
    const { listener, clients, emitToEveryone } = setup();
    await listener.connect();
    clients[0].handlers.error(new Error('reset'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    expect(emitToEveryone).toHaveBeenCalledTimes(1);

    // It drops again at once: the pause grows instead of starting over at one second.
    clients[1].handlers.error(new Error('reset'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(3);
    // The second resync waits for the gap, and is not lost.
    expect(emitToEveryone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REALTIME_RESYNC_GAP_MS);
    expect(emitToEveryone).toHaveBeenCalledTimes(2);
    await listener.onModuleDestroy();
  });

  it('also tells the technician named on a warranty claim', () => {
    const batch = groupChanges([{ t: 'warranty_claims', op: 'update', id: 'w1', so: ORDER, tech: OLD_TECH }]);
    expect([...batch.orders.get(ORDER)!]).toEqual(['warranty']);
    expect([...batch.orderTechnicians.get(ORDER)!]).toEqual([OLD_TECH]);
  });

  it('does nothing on a database that is not Postgres', async () => {
    const { listener, clients, gateway } = setup();
    (listener as any).dataSource = { options: { type: 'sqlite' } };
    await listener.connect();
    expect(clients).toHaveLength(0);
    expect(gateway.emitToEveryone).not.toHaveBeenCalled();
  });
});
