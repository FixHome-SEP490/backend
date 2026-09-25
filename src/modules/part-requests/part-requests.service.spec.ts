// src/modules/part-requests/part-requests.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PartRequestsService } from './part-requests.service';
import {
  PartRequestStatus,
  PartRequestType,
  FulfillmentMethod,
  PartUsageStatus,
  Role,
  ServiceOrderStatus,
} from '../../shared/enums';
import { PartRequestStateMachine } from './part-request-state-machine';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { PartRequestItem } from './entities/part-request-item.entity';
import { BusinessException } from '../../common/exceptions/business.exception';

describe('PartRequestStateMachine', () => {
  it('should allow valid transitions for PICKUP', () => {
    expect(
      PartRequestStateMachine.canTransitionWithFulfillment(
        PartRequestStatus.REQUESTED,
        PartRequestStatus.READY,
        FulfillmentMethod.PICKUP,
        Role.SERVICE_MANAGER,
      ),
    ).toBe(true);

    expect(
      PartRequestStateMachine.canTransitionWithFulfillment(
        PartRequestStatus.READY,
        PartRequestStatus.RECEIVED,
        FulfillmentMethod.PICKUP,
        Role.TECHNICIAN,
      ),
    ).toBe(true);

    expect(
      PartRequestStateMachine.canTransitionWithFulfillment(
        PartRequestStatus.RECEIVED,
        PartRequestStatus.COMPLETED,
        FulfillmentMethod.PICKUP,
      ),
    ).toBe(true);
  });

  it('should enforce DELIVERY transitions: READY -> DELIVERING -> RECEIVED', () => {
    // Cannot jump READY -> DELIVERING for PICKUP
    expect(
      PartRequestStateMachine.canTransitionWithFulfillment(
        PartRequestStatus.READY,
        PartRequestStatus.DELIVERING,
        FulfillmentMethod.PICKUP,
        Role.SERVICE_MANAGER,
      ),
    ).toBe(false);

    // Can transition READY -> DELIVERING for DELIVERY
    expect(
      PartRequestStateMachine.canTransitionWithFulfillment(
        PartRequestStatus.READY,
        PartRequestStatus.DELIVERING,
        FulfillmentMethod.DELIVERY,
        Role.SERVICE_MANAGER,
      ),
    ).toBe(true);

    // Can transition DELIVERING -> RECEIVED for DELIVERY
    expect(
      PartRequestStateMachine.canTransitionWithFulfillment(
        PartRequestStatus.DELIVERING,
        PartRequestStatus.RECEIVED,
        FulfillmentMethod.DELIVERY,
        Role.TECHNICIAN,
      ),
    ).toBe(true);
  });

  it('should block unauthorized role transitions', () => {
    // Technician cannot mark READY
    expect(
      PartRequestStateMachine.canTransition(
        PartRequestStatus.REQUESTED,
        PartRequestStatus.READY,
        Role.TECHNICIAN,
      ),
    ).toBe(false);

    // Customer cannot transition any part request state
    expect(
      PartRequestStateMachine.canTransition(
        PartRequestStatus.REQUESTED,
        PartRequestStatus.READY,
        Role.CUSTOMER,
      ),
    ).toBe(false);
  });

  it('blocks delivery shortcuts, terminal transitions and Admin operations', () => {
    expect(PartRequestStateMachine.canTransitionWithFulfillment(PartRequestStatus.READY, PartRequestStatus.RECEIVED, FulfillmentMethod.DELIVERY, Role.TECHNICIAN)).toBe(false);
    expect(PartRequestStateMachine.canTransition(PartRequestStatus.CANCELLED, PartRequestStatus.READY, Role.SERVICE_MANAGER)).toBe(false);
    expect(PartRequestStateMachine.canTransition(PartRequestStatus.REQUESTED, PartRequestStatus.READY, Role.ADMIN)).toBe(false);
  });
});

describe('PartRequestsService', () => {
  let service: PartRequestsService;
  let mockPartRequestRepo: any;
  let mockPartRequestItemRepo: any;
  let mockFixHomePartRepo: any;
  let mockAuditLogService: any;
  let mockNotificationsService: any;
  let mockDataSource: any;
  let mockEntityManager: any;

  beforeEach(() => {
    mockEntityManager = {
      findOne: vi.fn(),
      findOneOrFail: vi.fn(),
      findOneBy: vi.fn(),
      find: vi.fn().mockResolvedValue([]),
      create: vi.fn((entityClass, data) => ({ ...data, id: 'pr-uuid-1' })),
      save: vi.fn((entityClass, data) => Promise.resolve(data)),
    };

    mockDataSource = {
      transaction: vi.fn((cb) => cb(mockEntityManager)),
    };

    mockPartRequestRepo = {
      findOne: vi.fn(),
      find: vi.fn(),
      createQueryBuilder: vi.fn(),
    };

    mockPartRequestItemRepo = {
      save: vi.fn(),
    };

    mockFixHomePartRepo = {
      findOne: vi.fn(),
    };

    mockAuditLogService = {
      logWithManager: vi.fn().mockResolvedValue(undefined),
    };

    mockNotificationsService = {
      createNotification: vi.fn().mockResolvedValue({}),
    };

    service = new PartRequestsService(
      mockDataSource,
      mockPartRequestRepo,
      mockPartRequestItemRepo,
      mockFixHomePartRepo,
      mockAuditLogService,
      mockNotificationsService,
    );
  });

  describe('createPreRepairRequest', () => {
    it('should reject if order is not in ACCEPTED status', async () => {
      mockEntityManager.findOne.mockResolvedValueOnce({
        id: 'order-1',
        status: ServiceOrderStatus.EN_ROUTE,
      });
      mockEntityManager.findOneBy.mockResolvedValueOnce({
        serviceOrderId: 'order-1',
        technicianId: 'tech-1',
        isActive: true,
      });

      await expect(
        service.createPreRepairRequest(
          'order-1',
          {
            items: [{ partCatalogId: 'part-1', quantity: 1 }],
          },
          { id: 'tech-1', role: Role.TECHNICIAN },
        ),
      ).rejects.toThrow(BusinessException);
    });

    it('should reject if an active pre-repair request already exists for this order', async () => {
      mockEntityManager.findOne
        // authorizeOrder findOne ServiceOrder
        .mockResolvedValueOnce({
          id: 'order-1',
          status: ServiceOrderStatus.ACCEPTED,
        })
        // existingActive findOne PartRequest
        .mockResolvedValueOnce({
          id: 'existing-pr',
          status: PartRequestStatus.REQUESTED,
          requestType: PartRequestType.PRE_REPAIR,
        });
      mockEntityManager.findOneBy.mockResolvedValueOnce({
        serviceOrderId: 'order-1',
        technicianId: 'tech-1',
        isActive: true,
      });

      await expect(
        service.createPreRepairRequest(
          'order-1',
          {
            items: [{ partCatalogId: 'part-1', quantity: 1 }],
          },
          { id: 'tech-1', role: Role.TECHNICIAN },
        ),
      ).rejects.toThrow('A pre-repair parts request already exists for this order');
    });

    it('should successfully create pre-repair parts request with catalog snapshot', async () => {
      mockEntityManager.findOne
        // ServiceOrder
        .mockResolvedValueOnce({
          id: 'order-1',
          status: ServiceOrderStatus.ACCEPTED,
        })
        // existingActive: null
        .mockResolvedValueOnce(null)
        // FixHomePart lookup
        .mockResolvedValueOnce({
          id: 'part-1',
          name: 'Main Motherboard V2',
          sellingPrice: 500000,
          isActive: true,
        });

      mockEntityManager.findOneBy.mockResolvedValueOnce({
        serviceOrderId: 'order-1',
        technicianId: 'tech-1',
        isActive: true,
      });

      mockEntityManager.find.mockResolvedValueOnce([]); // SM users

      const result = await service.createPreRepairRequest(
        'order-1',
        {
          items: [{ partCatalogId: 'part-1', quantity: 2, note: 'Need 2 boards' }],
          reason: 'Initial diagnosis shows board failure',
        },
        { id: 'tech-1', role: Role.TECHNICIAN },
      );

      expect(result).toBeDefined();
      expect(mockAuditLogService.logWithManager).toHaveBeenCalled();
    });
  });

  function mockMutation(request: any, item?: any, order: any = { id: 'order-1', status: ServiceOrderStatus.UNDER_REPAIR }) {
    mockEntityManager.findOne.mockImplementation(async (entity: any) => entity === ServiceOrder ? order : entity === PartRequestItem ? item : request);
    mockEntityManager.findOneOrFail.mockResolvedValue(request);
    mockEntityManager.findOneBy.mockResolvedValue({ technicianId: 'tech-1', isActive: true });
  }

  it('denies request detail to an unrelated Customer and strips handover token from owner reads', async () => {
    const request = { id: 'pr-1', serviceOrderId: 'order-1', qrToken: 'secret', items: [] };
    mockPartRequestRepo.findOne.mockResolvedValue(request);
    mockDataSource.manager = mockEntityManager;
    mockEntityManager.findOne.mockResolvedValue({ id: 'order-1', bookingId: 'booking-1' });
    mockEntityManager.findOneBy.mockResolvedValue(null);
    await expect(service.getById('pr-1', { id: 'outsider', role: Role.CUSTOMER })).rejects.toThrow('access denied');
    mockEntityManager.findOneBy.mockResolvedValue({ customerId: 'owner' });
    expect((await service.getById('pr-1', { id: 'owner', role: Role.CUSTOMER })).qrToken).toBeNull();
  });

  it('blocks mutations after cancellation, reassignment, or invoice freeze', async () => {
    const request = { id: 'pr-1', serviceOrderId: 'order-1', technicianId: 'tech-1', status: PartRequestStatus.REQUESTED };
    mockMutation(request, undefined, { status: ServiceOrderStatus.CANCELLED });
    await expect(service.markReady('pr-1', { id: 'sm', role: Role.SERVICE_MANAGER })).rejects.toThrow('immutable');
    mockMutation(request, undefined, { status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: new Date() });
    await expect(service.updateItemUsage('pr-1', 'item', { usageStatus: PartUsageStatus.RETURNED }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow('immutable');
    mockMutation(request);
    mockEntityManager.findOneBy.mockResolvedValue(null);
    await expect(service.receiveByQr('pr-1', { qrToken: 'token' }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow('access denied');
  });

  it('rejects expired QR and resetting usage to PENDING', async () => {
    mockMutation({ id: 'pr-1', technicianId: 'tech-1', status: PartRequestStatus.READY, fulfillmentMethod: FulfillmentMethod.PICKUP, qrToken: 'token', qrGeneratedAt: new Date(Date.now() - 49 * 3600000) });
    await expect(service.receiveByQr('pr-1', { qrToken: 'token' }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow('expired');
    await expect(service.updateItemUsage('pr-1', 'item', { usageStatus: PartUsageStatus.PENDING }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow('USED or RETURNED');
  });

  describe('markReady', () => {
    it('should generate secure QR token and update status to READY', async () => {
      const existingRequest = {
        id: 'pr-12345678-abcd',
        status: PartRequestStatus.REQUESTED,
        fulfillmentMethod: FulfillmentMethod.PICKUP,
        technicianId: 'tech-1',
        serviceOrderId: 'order-1',
      };

      mockMutation(existingRequest);

      const result = await service.markReady(
        'pr-1',
        { id: 'sm-1', role: Role.SERVICE_MANAGER },
        { note: 'Parts assembled' },
      );

      expect(result.status).toBe(PartRequestStatus.READY);
      expect(result.qrToken).toBeDefined();
      expect(result.qrToken).toMatch(/^FH-PR-/);
      expect(result.preparedByUserId).toBe('sm-1');
      expect(mockNotificationsService.createNotification).toHaveBeenCalled();
    });
  });

  describe('receiveByQr', () => {
    it('should successfully receive parts with valid token', async () => {
      const validToken = 'FH-PR-pr-1234-token123';
      const request = {
        id: 'pr-1',
        technicianId: 'tech-1',
        serviceOrderId: 'order-1',
        status: PartRequestStatus.READY,
        fulfillmentMethod: FulfillmentMethod.PICKUP,
        qrToken: validToken,
        qrGeneratedAt: new Date(),
        receivedAt: null,
      };

      mockMutation(request);

      const result = await service.receiveByQr(
        'pr-1',
        { qrToken: validToken },
        { id: 'tech-1', role: Role.TECHNICIAN },
      );

      expect(result.status).toBe(PartRequestStatus.RECEIVED);
      expect(result.receivedAt).toBeDefined();
      expect(result.qrToken).toBeNull();
      await expect(service.receiveByQr('pr-1', { qrToken: validToken }, { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow('already been received');
    });

    it('should reject if scanned by another technician', async () => {
      const request = {
        id: 'pr-1',
        technicianId: 'tech-1',
        serviceOrderId: 'order-1',
        status: PartRequestStatus.READY,
        fulfillmentMethod: FulfillmentMethod.PICKUP,
        qrToken: 'valid-token',
      };

      mockMutation(request);

      await expect(
        service.receiveByQr(
          'pr-1',
          { qrToken: 'valid-token' },
          { id: 'tech-2-impostor', role: Role.TECHNICIAN },
        ),
      ).rejects.toThrow('This part request belongs to another technician');
    });

    it('should reject if QR token does not match', async () => {
      const request = {
        id: 'pr-1',
        technicianId: 'tech-1',
        serviceOrderId: 'order-1',
        status: PartRequestStatus.READY,
        fulfillmentMethod: FulfillmentMethod.PICKUP,
        qrToken: 'correct-token',
      };

      mockMutation(request);

      await expect(
        service.receiveByQr(
          'pr-1',
          { qrToken: 'wrong-token' },
          { id: 'tech-1', role: Role.TECHNICIAN },
        ),
      ).rejects.toThrow('Invalid QR token for this part request');
    });

    it('should accept TEST_SCAN token for dev testing and transition to RECEIVED', async () => {
      const request = {
        id: 'pr-1',
        technicianId: 'tech-1',
        serviceOrderId: 'order-1',
        status: PartRequestStatus.REQUESTED,
        fulfillmentMethod: FulfillmentMethod.PICKUP,
      };

      mockMutation(request);

      const result = await service.receiveByQr(
        'pr-1',
        { qrToken: 'TEST_SCAN' },
        { id: 'tech-1', role: Role.TECHNICIAN },
      );

      expect(result.status).toBe(PartRequestStatus.RECEIVED);
      expect(result.receivedAt).toBeDefined();
    });
  });

  describe('updateItemUsage', () => {
    it('should update item status to USED or RETURNED', async () => {
      const request = {
        id: 'pr-1',
        technicianId: 'tech-1',
        status: PartRequestStatus.RECEIVED,
      };
      const item = {
        id: 'item-1',
        partRequestId: 'pr-1',
        usageStatus: PartUsageStatus.PENDING,
      };

      mockMutation(request, item);

      const result = await service.updateItemUsage(
        'pr-1',
        'item-1',
        { usageStatus: PartUsageStatus.USED },
        { id: 'tech-1', role: Role.TECHNICIAN },
      );

      expect(result.usageStatus).toBe(PartUsageStatus.USED);
    });
  });
});
