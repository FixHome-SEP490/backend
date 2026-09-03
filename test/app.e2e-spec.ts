import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../dist/app.module.js';

process.env.JWT_SECRET ||= 'fixhome-e2e-only-secret';

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  it('/api/v1/health (GET)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'fixhome-backend',
      dependencies: {
        database: 'connected',
      },
    });
  });

  it('/ (GET) returns 404', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(404);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });
});
