import { describe, expect, it, vi } from 'vitest';
import { WebRtcService } from './webrtc.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';

const chatId = 'b328d682-7f7b-49eb-8554-cb9db1b6e998';

describe('WebRTC repeated open', () => {
  function fixture(existing: string | null = null) {
    let stored = existing;
    const evalCall = vi.fn(async (_script: string, options: { arguments: string[] }) => {
      if (options.arguments[1] === '0') return '';
      stored ??= options.arguments[0];
      return stored;
    });
    const prisma = {
      privateChat: { findUnique: vi.fn().mockResolvedValue({ id: chatId, creatorId: 'a', peerId: 'b', status: 'ACTIVE' }) },
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'a', userId: 1111111111n }, { id: 'b', userId: 1000000000n }]) },
    };
    const service = new WebRtcService(prisma as unknown as PrismaService,
      { getClient: () => ({ eval: evalCall }) } as unknown as RedisService);
    return { service, evalCall };
  }

  it('reuses a session for duplicate and simultaneous opens by both participants', async () => {
    const { service, evalCall } = fixture();
    const [a, b] = await Promise.all([
      service.openChat('1111111111', chatId, true), service.openChat('1000000000', chatId, true),
    ]);
    const repeated = await service.openChat('1111111111', chatId, true);
    expect(a.state.sessionId).toBe(b.state.sessionId);
    expect(repeated.state.sessionId).toBe(a.state.sessionId);
    expect(a.state.role).not.toBe(b.state.role);
    expect(a.replacedSessionId).toBeNull();
    expect(evalCall.mock.calls[0][0]).toContain("redis.call('GET', KEYS[1])");
  });

  it('waits when the peer has not opened the chat', async () => {
    const { service } = fixture();
    const result = await service.openChat('1111111111', chatId, false);
    expect(result.state.ready).toBe(false);
    expect(result.state.sessionId).toBeNull();
  });

  it('rejects users outside the chat before touching Redis', async () => {
    const { service, evalCall } = fixture();
    await expect(service.openChat('1234567890', chatId, true)).rejects.toThrow();
    expect(evalCall).not.toHaveBeenCalled();
  });
});
