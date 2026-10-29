import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PushService } from './push.service.js';

@Controller('push')
export class PushController {
  constructor(private readonly jwt: JwtService, private readonly push: PushService) {}

  private async authenticatedUser(authorization?: string) {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<{ userId?: unknown }>(match[1]);
      if (typeof payload.userId !== 'string' || !/^\d{10}$/.test(payload.userId)) throw new UnauthorizedException();
      return payload.userId;
    } catch {
      throw new UnauthorizedException();
    }
  }

  @Post('token')
  async registerToken(@Headers('authorization') authorization: string | undefined, @Body() body: { token?: unknown }) {
    const userId = await this.authenticatedUser(authorization);
    if (typeof body.token !== 'string' || !/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/.test(body.token)) {
      throw new BadRequestException('Invalid Expo push token');
    }
    await this.push.registerToken(userId, body.token);
    return { registered: true };
  }
}
