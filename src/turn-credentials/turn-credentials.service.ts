import { createHmac } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CREDENTIAL_TTL_SECONDS = 10 * 60;

@Injectable()
export class TurnCredentialsService {
  constructor(private readonly config: ConfigService) {}

  issue(userId: string) {
    const host = this.config.get<string>('TURN_HOST');
    const port = Number(this.config.get<string>('TURN_PORT') ?? '3478');
    const secret = this.config.get<string>('TURN_SHARED_SECRET');
    if (!host || !secret || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ServiceUnavailableException('TURN service is not configured');
    }
    const expiresAt = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS;
    const username = `${expiresAt}:${userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    return { urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`], username, credential, expiresAt };
  }
}
