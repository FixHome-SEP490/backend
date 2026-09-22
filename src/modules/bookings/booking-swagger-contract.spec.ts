import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { InvitationsController } from './invitations.controller';
import { BookingsService } from './bookings.service';
import { InvitationsService } from './invitations.service';
import { BookingPrivateMediaContentService } from './booking-private-media-content.service';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { QuotationsController } from '../quotations/quotations.controller';
import { QuotationsService } from '../quotations/quotations.service';
import { ServiceOrdersController } from '../service-orders/service-orders.controller';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { RolesGuard } from '../../common/guards/roles.guard';

describe('Booking Swagger contract: ordered invitations', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it('documents creation, ordered invitations, evidence, quotation and completion requests', async () => {
    const module = await Test.createTestingModule({
      controllers: [BookingsController, InvitationsController, QuotationsController, ServiceOrdersController],
      providers: [
        { provide: BookingsService, useValue: {} },
        { provide: InvitationsService, useValue: {} },
        { provide: QuotationsService, useValue: {} },
        { provide: ServiceOrdersService, useValue: {} },
        { provide: BookingPrivateMediaContentService, useValue: {} },
      ],
    })
      .overrideGuard(PermissionGuard).useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('FixHome').setVersion('1').build());
    const shortlist = doc.paths['/api/v1/bookings/{id}/shortlist']?.post;
    const respond = doc.paths['/api/v1/invitations/{id}/respond']?.post;
    const createBooking = doc.paths['/api/v1/bookings']?.post;
    expect(createBooking?.summary).toContain('create a Booking');
    expect(doc.components?.schemas?.CreateBookingDto).toMatchObject({
      required: expect.arrayContaining(['serviceId', 'addressId', 'description', 'preferredStartAt', 'preferredEndAt']),
      properties: {
        serviceId: { type: 'string', format: 'uuid' },
        addressId: { type: 'string', format: 'uuid' },
        urgency: { enum: ['low', 'medium', 'high', 'critical'] },
        photoUploadIds: { type: 'array', maxItems: 5 },
      },
    });
    const gps = doc.paths['/api/v1/service-orders/{id}/check-in']?.post;
    expect(gps?.description).toContain('valid');
    expect(doc.components?.schemas?.CheckInDto).toMatchObject({
      required: expect.arrayContaining(['lat', 'lng', 'accuracyMeters']),
      properties: { lat: { type: 'number' }, lng: { type: 'number' }, accuracyMeters: { type: 'number', minimum: 0 } },
    });
    const evidence = doc.paths['/api/v1/service-orders/{id}/evidence']?.post;
    const evidenceBody = evidence?.requestBody;
    expect(evidenceBody && 'content' in evidenceBody ? evidenceBody.content?.['multipart/form-data']?.schema : undefined).toMatchObject({
      required: ['type', 'file'],
      properties: {
        type: { enum: ['before', 'after', 'additional'] },
        file: { type: 'string', format: 'binary' },
      },
    });
    const requestCompletion = doc.paths['/api/v1/service-orders/{id}/request-completion']?.post;
    const confirmCompletion = doc.paths['/api/v1/service-orders/{id}/confirm-completion']?.post;
    expect(requestCompletion?.description).toContain('NOT immediately');
    expect(confirmCompletion?.description).toContain('verified paid');
    expect(doc.components?.schemas?.CompletionRequestDto).toMatchObject({ properties: { completionNote: { type: 'string' } } });
    expect(doc.components?.schemas?.CompletionConfirmationDto).toMatchObject({
      properties: { feedback: { type: 'string' }, rating: { type: 'number', minimum: 1, maximum: 5 }, signatureUrl: { type: 'string', format: 'uri' } },
    });    expect(shortlist?.summary).toContain('exactly two');
    expect(shortlist?.description).toContain('STANDBY');
    expect(shortlist?.summary).not.toContain('5');
    expect(doc.components?.schemas?.ShortlistDto).toMatchObject({
      required: ['technicianIds'],
      properties: { technicianIds: {
        type: 'array', minItems: 2, maxItems: 2, uniqueItems: true,
        items: { type: 'string' },
      } },
    });
    expect(respond?.description).toContain('PENDING');
    const quote = doc.paths['/api/v1/service-orders/{id}/quotations']?.post;
    const decision = doc.paths['/api/v1/quotations/{id}/decision']?.post;
    expect(quote?.summary).toContain('Technician');
    expect(doc.components?.schemas?.CreateQuotationDto).toMatchObject({
      required: ['items'],
      properties: { items: { type: 'array', minItems: 1, maxItems: 100 } },
    });
    expect(doc.components?.schemas?.CreateCostItemDto).toMatchObject({
      required: expect.arrayContaining(['type', 'description', 'quantity', 'unitPrice']),
      properties: {
        type: { enum: ['labor', 'parts_equipment'] },
        quantity: { type: 'number', minimum: 1 },
        unitPrice: { type: 'number', minimum: 0 },
      },
    });
    expect(decision?.summary).toContain('Customer');
    expect(doc.components?.schemas?.FinancialDecisionDto).toMatchObject({
      required: ['action'], properties: { action: { enum: ['APPROVE', 'REJECT'] } },
    });
    expect(doc.components?.schemas?.InvitationResponseDto).toMatchObject({
      required: ['action'],
      properties: { action: { enum: ['ACCEPT', 'DECLINE'] } },
    });
  });
});