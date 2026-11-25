import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { AdminTechnicianVerificationsController } from '../technician-verifications/admin-technician-verifications.controller';
import { AdminTechnicianSkillVerificationsController } from '../technician-skill-verifications/admin-technician-skill-verifications.controller';
import { AdminOfficeVisitsController, AdminProfileReviewsController } from '../technician-office-visits/office-visit.controllers';

// Service Manager decides the technician onboarding review; Admin only reads it (customer KYC is covered in its own spec).
const READ = [Role.ADMIN, Role.SERVICE_MANAGER];
const DECIDE = [Role.SERVICE_MANAGER];

describe('technician onboarding review roles', () => {
  const rolesOf = (controller: { prototype: object }, handler: string) =>
    Reflect.getMetadata(ROLES_KEY, (controller.prototype as Record<string, object>)[handler]) ??
    Reflect.getMetadata(ROLES_KEY, controller);

  it.each([
    [AdminTechnicianVerificationsController, ['findAll', 'findById', 'getDocumentAccess'], ['approve', 'reject']],
    [AdminTechnicianSkillVerificationsController, ['findAll', 'findById', 'getDocumentAccess'], ['createCertificateUploadUrl', 'approve', 'reject']],
    [AdminProfileReviewsController, ['list', 'get'], ['approve', 'reopen', 'reject']],
    [AdminOfficeVisitsController, ['list'], ['attended', 'missed', 'reset']],
  ] as const)('%o: admin reads, only the service manager decides', (controller, reads, decides) => {
    for (const handler of reads) expect(rolesOf(controller, handler)).toEqual(READ);
    for (const handler of decides) expect(rolesOf(controller, handler)).toEqual(DECIDE);
  });
});
