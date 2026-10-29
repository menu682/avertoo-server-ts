import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TurnCredentialsController } from './turn-credentials.controller.js';
import { TurnCredentialsModule } from './turn-credentials.module.js';

describe('TURN credentials authentication and module wiring', () => {
  let module: TestingModule;
  let controller: TurnCredentialsController;
  let jwt: JwtService;
  const sharedSecret = 'test-only-coturn-shared-secret';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_ACCESS_SECRET: 'test-only-access-secret', TURNSTILE_SECRET_KEY: 'test-only-captcha-secret', TURN_HOST: 'turn.example.test', TURN_SHARED_SECRET: sharedSecret })],
        }),
        PrismaModule,
        TurnCredentialsModule,
      ],
    }).overrideProvider(PrismaService).useValue({}).compile();
    controller = module.get(TurnCredentialsController);
    jwt = module.get(JwtService);
  });

  afterAll(async () => { await module?.close(); });

  it('rejects missing, malformed and expired access tokens', async () => {
    await expect(controller.getCredentials()).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.getCredentials('Bearer invalid')).rejects.toBeInstanceOf(UnauthorizedException);
    const expired = await jwt.signAsync({ userId: '1234567890' }, { expiresIn: -1 });
    await expect(controller.getCredentials(`Bearer ${expired}`)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('issues short-lived coturn REST credentials to an authenticated user', async () => {
    const token = await jwt.signAsync({ userId: '1234567890' });
    const before = Math.floor(Date.now() / 1000);
    const result = await controller.getCredentials(`Bearer ${token}`);
    expect(result.username).toBe(`${result.expiresAt}:1234567890`);
    expect(result.expiresAt).toBeGreaterThan(before);
    expect(result.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
    expect(result.credential).toBe(createHmac('sha1', sharedSecret).update(result.username).digest('base64'));
    expect(result.urls).toEqual(['turn:turn.example.test:3478?transport=udp', 'turn:turn.example.test:3478?transport=tcp']);
  });
});
