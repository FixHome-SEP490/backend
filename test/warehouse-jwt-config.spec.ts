import 'reflect-metadata';
import { Controller, Get, INestApplication, Req, UseGuards } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, it, vi } from 'vitest';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { warehouseJwtConfig } from './warehouse-jwt-config';

@Controller('warehouse-auth-probe')
@UseGuards(JwtAuthGuard)
class AuthProbe {
  @Get()
  get(@Req() req: { user: { id: string; role: string } }) { return { id: req.user.id, role: req.user.role }; }
}

describe('W2 JWT bootstrap uses the effective Passport configuration', () => {
  let app: INestApplication;
  afterEach(async () => { if (app) await app.close(); vi.unstubAllEnvs(); });
  it('accepts its own signed JWT with CI env present, rejects absent/incorrect JWT and reads the stored role', async () => {
    vi.stubEnv('JWT_ACCESS_SECRET', 'ci-env-secret-with-at-least-32-characters');
    const auth = warehouseJwtConfig('w2-fallback-secret-with-at-least-32-characters');
    const user = { id: randomUUID(), role: 'technician', status: 'active', isActive: true };
    // Repository boundary only; the real Passport strategy and JwtAuthGuard remain in use.
    const strategy = new JwtStrategy(auth.config, { findOne: vi.fn(async () => user) } as never);
    const module = await Test.createTestingModule({ imports: [PassportModule, JwtModule.register({ secret: auth.secret })],
      controllers: [AuthProbe], providers: [{ provide: JwtStrategy, useValue: strategy }] }).compile();
    app = module.createNestApplication(); app.useLogger(false); await app.init();
    const jwt = module.get(JwtService);
    await request(app.getHttpServer()).get('/warehouse-auth-probe').expect(401);
    await request(app.getHttpServer()).get('/warehouse-auth-probe').set('Authorization', `Bearer ${jwt.sign({ sub: user.id }, { secret: 'wrong-key' })}`).expect(401);
    await request(app.getHttpServer()).get('/warehouse-auth-probe').set('Authorization', `Bearer ${jwt.sign({ sub: user.id, role: 'admin' })}`)
      .expect(200, { id: user.id, role: 'technician' });
  });
});
