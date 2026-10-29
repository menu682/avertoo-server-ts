import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  constructor(private readonly prisma: PrismaService) {}

  async registerToken(publicUserId: string, token: string) {
    const user = await this.prisma.user.findUnique({ where: { userId: BigInt(publicUserId) }, select: { id: true } });
    if (!user) return;
    await this.prisma.devicePushToken.upsert({
      where: { userId: user.id },
      create: { userId: user.id, token },
      update: { token },
    });
  }

  async wakeChat(senderPublicId: string, chatId: string) {
    const sender = await this.prisma.user.findUnique({ where: { userId: BigInt(senderPublicId) }, select: { id: true } });
    if (!sender) return;
    const chat = await this.prisma.privateChat.findUnique({ where: { id: chatId }, select: { creatorId: true, peerId: true, status: true } });
    if (!chat || chat.status !== 'ACTIVE' || (chat.creatorId !== sender.id && chat.peerId !== sender.id)) return;
    const targetId = chat.creatorId === sender.id ? chat.peerId : chat.creatorId;
    const user = await this.prisma.user.findUnique({ where: { id: targetId }, select: { devicePushToken: { select: { token: true } } } });
    const token = user?.devicePushToken?.token;
    if (!token) return;
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ to: token, data: { type: 'wake', chatId }, priority: 'high', contentAvailable: true }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        this.logger.warn(`Push send failed with status ${response.status}`);
        return;
      }
      const result: unknown = await response.json();
      if (typeof result !== 'object' || result === null || !('data' in result)) {
        this.logger.warn('Push service returned an invalid ticket response');
        return;
      }
      const tickets = Array.isArray(result.data) ? result.data : [result.data];
      for (const ticket of tickets) {
        if (typeof ticket !== 'object' || ticket === null || !('status' in ticket) || ticket.status !== 'error') continue;
        const details: unknown = 'details' in ticket ? ticket.details : null;
        const code = typeof details === 'object' && details !== null && 'error' in details && typeof details.error === 'string'
          ? details.error : 'UnknownError';
        this.logger.warn(`Push ticket rejected: ${code}`);
        if (code === 'DeviceNotRegistered') {
          await this.prisma.devicePushToken.deleteMany({ where: { userId: targetId, token } });
        }
      }
    } catch (error) {
      this.logger.warn(`Push service unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
