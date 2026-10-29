import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TurnCredentialsService } from './turn-credentials.service.js';

@Controller('webrtc')
export class TurnCredentialsController {
  constructor(private readonly jwt: JwtService, private readonly turn: TurnCredentialsService) {}

  @Get('turn-credentials')
  async getCredentials(@Headers('authorization') authorization?: string) {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new UnauthorizedException();
    let userId: unknown;
    try {
      const payload = await this.jwt.verifyAsync<{ userId?: unknown }>(match[1]);
      userId = payload.userId;
    } catch {
      throw new UnauthorizedException();
    }
    if (typeof userId !== 'string' || !/^\d{10}$/.test(userId)) throw new UnauthorizedException();
    return this.turn.issue(userId);
  }
}
