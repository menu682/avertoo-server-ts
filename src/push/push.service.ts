import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class PushService implements OnModuleDestroy {
  private readonly receiptTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly lastWake = new Map<string, number>();

  onModuleDestroy() {
    for (const timer of this.receiptTimers) clearTimeout(timer);
    this.receiptTimers.clear();
  }
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
    const previous = this.lastWake.get(chatId) ?? 0;
    if (Date.now() - previous < 10_000) return;
    this.lastWake.set(chatId, Date.now());
    if (this.lastWake.size > 1000) {
      for (const [id, sentAt] of this.lastWake) if (Date.now() - sentAt > 60_000) this.lastWake.delete(id);
    }
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ to: token, data: { type: 'wake', chatId }, priority: 'high', contentAvailable: true, ttl: 60 }),
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
        if (typeof ticket !== 'object' || ticket === null || !('status' in ticket)) continue;
        if (ticket.status === 'ok' && 'id' in ticket && typeof ticket.id === 'string') {
          this.logger.log('Wake push accepted by Expo');
          this.scheduleReceipt(ticket.id, targetId, token);
          continue;
        }
        if (ticket.status !== 'error') continue;
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

  private scheduleReceipt(id: string, userId: string, token: string, attempt = 0) {
    if (this.receiptTimers.size >= 1000) return;
    const timer = setTimeout(() => {
      this.receiptTimers.delete(timer);
      void this.readReceipt(id, userId, token, attempt);
    }, attempt === 0 ? 15_000 : 60_000);
    timer.unref();
    this.receiptTimers.add(timer);
  }

  private async readReceipt(id: string, userId: string, token: string, attempt: number) {
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: [id] }), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Receipt HTTP ${response.status}`);
      const result = await response.json() as { data?: Record<string, { status?: string; details?: { error?: string } }> };
      const receipt = result.data?.[id];
      if (!receipt) {
        if (attempt < 15) this.scheduleReceipt(id, userId, token, attempt + 1);
        else this.logger.warn('Wake push receipt unavailable after retries');
        return;
      }
      if (receipt.status === 'ok') this.logger.log('Wake push accepted by FCM/APNs (device execution must be checked separately)');
      else {
        const code = receipt.details?.error ?? 'UnknownError';
        this.logger.warn(`Wake push delivery rejected: ${code}`);
        if (code === 'DeviceNotRegistered') await this.prisma.devicePushToken.deleteMany({ where: { userId, token } });
      }
    } catch {
      this.logger.warn('Wake push receipt lookup failed');
      if (attempt < 15) this.scheduleReceipt(id, userId, token, attempt + 1);
    }
  }

}
