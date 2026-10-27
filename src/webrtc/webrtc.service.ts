import { randomUUID } from 'node:crypto';

import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { RedisClientType } from 'redis';

import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { WebRtcSignalDto } from './dto/webrtc-signal.dto.js';
import type {
    EndWebRtcSessionDto,
    WebRtcSessionStatusDto,
} from './dto/webrtc-session.dto.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_SIGNAL_BYTES = 64 * 1024;

type WebRtcRole = 'OFFERER' | 'ANSWERER';
type WebRtcStatus = WebRtcSessionStatusDto['status'];

interface WebRtcSession {
    chatId: string;
    sessionId: string;
    offererId: string;
    userA: string;
    userB: string;
    createdAt: number;
}

interface ChatPresence {
    chatId: string;
    peerId: string;
    ready: boolean;
    role: WebRtcRole | null;
    peerRole: WebRtcRole | null;
    offererId: string | null;
    sessionId: string | null;
    previousChatId: string | null;
}

interface ChatParticipants {
    creatorUserId: string;
    peerUserId: string;
    otherUserId: string;
}

interface SessionContext {
    session: WebRtcSession;
    peerId: string;
    role: WebRtcRole;
}

@Injectable()
export class WebRtcService {
    private readonly redis: RedisClientType;

    constructor(
        private readonly prisma: PrismaService,
        redisService: RedisService,
    ) {
        this.redis = redisService.getClient();
    }

    async assertChatAccess( userId: string, chatId: string ): Promise<void> {
        await this.getChatParticipants( userId, chatId );
    }

    async openChat(
        userId: string,
        chatId: string,
        peerHasChatOpen: boolean,
    ): Promise<{ state: ChatPresence; replacedSessionId: string | null }> {
        const participants = await this.getChatParticipants(
            userId,
            chatId,
        );

        const otherUserId = participants.otherUserId;
        const sessionKey = this.getSessionKey( chatId );
        const existingValue = await this.redis.get( sessionKey );
        let replacedSessionId: string | null = null;

        if ( existingValue ) {
            try {
                const existing = JSON.parse( existingValue ) as WebRtcSession;
                if ( this.isValidSessionForParticipants(
                    existing,
                    chatId,
                    participants.creatorUserId,
                    participants.peerUserId,
                ) ) {
                    replacedSessionId = existing.sessionId;
                }
            } catch {
                // Ignore malformed old session state and replace it below.
            }
        }

        if ( !peerHasChatOpen ) {
            if ( existingValue ) {
                await this.redis.eval(
                    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
                    { keys: [ sessionKey ], arguments: [ existingValue ] },
                );
            }
            return {
                state: this.notReadyState( chatId, otherUserId ),
                replacedSessionId,
            };
        }

        const session: WebRtcSession = {
            chatId,
            sessionId: randomUUID(),
            offererId: userId,
            userA: userId,
            userB: otherUserId,
            createdAt: Date.now(),
        };

        await this.redis.set(
            sessionKey,
            JSON.stringify( session ),
            { EX: SESSION_TTL_SECONDS },
        );

        return {
            state: this.toPresence( userId, otherUserId, session ),
            replacedSessionId,
        };
    }

    /**
     * Перевіряє поточну сесію та повертає сигнал
     * для маршрутизації іншому учаснику.
     */
    async relaySignal(
        userId: string,
        dto: WebRtcSignalDto,
    ): Promise<{
        peerId: string;
        signal: {
            chatId: string;
            sessionId: string;
            fromUserId: string;
            type: WebRtcSignalDto['type'];
            data: Record<string, unknown>;
        };
    }> {
        const serialized = JSON.stringify( dto.data );

        if (
            typeof serialized !== 'string' ||
            Buffer.byteLength( serialized, 'utf8' ) > MAX_SIGNAL_BYTES
        ) {
            throw new ForbiddenException(
                'Розмір WebRTC-сигналу перевищує ліміт',
            );
        }

        const context = await this.getSessionContext(
            userId,
            dto.chatId,
            dto.sessionId,
        );

        if (
            dto.type === 'offer' &&
            context.role !== 'OFFERER'
        ) {
            throw new ForbiddenException(
                'Тільки OFFERER може надсилати offer',
            );
        }

        if (
            dto.type === 'answer' &&
            context.role !== 'ANSWERER'
        ) {
            throw new ForbiddenException(
                'Тільки ANSWERER може надсилати answer',
            );
        }

        return {
            peerId: context.peerId,
            signal: {
                chatId: dto.chatId,
                sessionId: dto.sessionId,
                fromUserId: userId,
                type: dto.type,
                data: dto.data,
            },
        };
    }

    async reportSessionStatus(
        userId: string,
        dto: WebRtcSessionStatusDto,
    ): Promise<{
        peerId: string;
        status: WebRtcStatus;
    }> {
        const context = await this.getSessionContext(
            userId,
            dto.chatId,
            dto.sessionId,
        );

        return {
            peerId: context.peerId,
            status: dto.status,
        };
    }

    /**
     * Закриває тільки ту сесію, sessionId якої збігається.
     * Старий запит не може видалити новішу сесію.
     */
    async endSession(
        userId: string,
        dto: EndWebRtcSessionDto,
    ): Promise<{
        peerId: string;
        ended: boolean;
    }> {
        const participants = await this.getChatParticipants(
            userId,
            dto.chatId,
        );

        const key = this.getSessionKey( dto.chatId );
        const raw = await this.redis.get( key );

        if ( !raw ) {
            return {
                peerId: participants.otherUserId,
                ended: false,
            };
        }

        let session: WebRtcSession;

        try {
            session = JSON.parse( raw ) as WebRtcSession;
        } catch {
            throw new ConflictException(
                'Некоректний стан WebRTC-сесії',
            );
        }

        if (
            session.sessionId !== dto.sessionId ||
            !this.isValidSessionForParticipants(
                session,
                dto.chatId,
                participants.creatorUserId,
                participants.peerUserId,
            )
        ) {
            return {
                peerId: participants.otherUserId,
                ended: false,
            };
        }

        const deleted = await this.redis.eval(
            `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                    return redis.call('DEL', KEYS[1])
                end
                return 0
            `,
            {
                keys: [ key ],
                arguments: [ raw ],
            },
        );

        return {
            peerId: participants.otherUserId,
            ended: Number( deleted ) === 1,
        };
    }

    /**
     * Замінює sessionId атомарно, зберігаючи OFFERER.
     * Якщо сесію вже змінив інший запит, повертає конфлікт.
     */
    async restartSession(
        userId: string,
        dto: EndWebRtcSessionDto,
    ): Promise<{
        peerId: string;
        state: ChatPresence;
    }> {
        const context = await this.getSessionContext(
            userId,
            dto.chatId,
            dto.sessionId,
        );

        const key = this.getSessionKey( dto.chatId );
        const raw = await this.redis.get( key );

        if ( !raw ) {
            throw new ConflictException(
                'WebRTC-сесія вже завершена',
            );
        }

        const newSession: WebRtcSession = {
            ...context.session,
            sessionId: randomUUID(),
            createdAt: Date.now(),
        };

        const replaced = await this.redis.eval(
            `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                    redis.call(
                        'SET',
                        KEYS[1],
                        ARGV[2],
                        'EX',
                        ARGV[3]
                    )
                    return 1
                end
                return 0
            `,
            {
                keys: [ key ],
                arguments: [
                    raw,
                    JSON.stringify( newSession ),
                    String( SESSION_TTL_SECONDS ),
                ],
            },
        );

        if ( Number( replaced ) !== 1 ) {
            throw new ConflictException(
                'Сесію вже змінив інший запит',
            );
        }

        return {
            peerId: context.peerId,
            state: this.toPresence(
                userId,
                context.peerId,
                newSession,
            ),
        };
    }

    async closeChat(
        userId: string,
        chatId: string,
    ): Promise<{ chatId: string; peerId: string; sessionId: string | null }> {
        const participants = await this.getChatParticipants( userId, chatId );
        const key = this.getSessionKey( chatId );
        const raw = await this.redis.get( key );

        if ( !raw ) {
            return { chatId, peerId: participants.otherUserId, sessionId: null };
        }

        let session: WebRtcSession;
        try {
            session = JSON.parse( raw ) as WebRtcSession;
        } catch {
            await this.redis.del( key );
            return { chatId, peerId: participants.otherUserId, sessionId: null };
        }

        if ( !this.isValidSessionForParticipants( session, chatId, participants.creatorUserId, participants.peerUserId ) ) {
            return { chatId, peerId: participants.otherUserId, sessionId: null };
        }

        const deleted = await this.redis.eval(
            `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
            { keys: [ key ], arguments: [ raw ] },
        );

        return {
            chatId,
            peerId: participants.otherUserId,
            sessionId: Number( deleted ) === 1 ? session.sessionId : null,
        };
    }

    private async getSessionContext(
        userId: string,
        chatId: string,
        sessionId: string,
    ): Promise<SessionContext> {
        const participants = await this.getChatParticipants(
            userId,
            chatId,
        );

        const key = this.getSessionKey( chatId );
        const raw = await this.redis.get( key );

        if ( !raw ) {
            throw new ConflictException(
                'WebRTC-сесія не існує або вже завершена',
            );
        }

        let session: WebRtcSession;

        try {
            session = JSON.parse( raw ) as WebRtcSession;
        } catch {
            throw new ConflictException(
                'Некоректний стан WebRTC-сесії',
            );
        }

        if (
            session.sessionId !== sessionId ||
            !this.isValidSessionForParticipants(
                session,
                chatId,
                participants.creatorUserId,
                participants.peerUserId,
            )
        ) {
            throw new ConflictException(
                'WebRTC-сесія застаріла або не відповідає цьому чату',
            );
        }

        if (
            session.offererId !== participants.creatorUserId &&
            session.offererId !== participants.peerUserId
        ) {
            throw new ConflictException(
                'Некоректний ініціатор WebRTC-сесії',
            );
        }

        // Подовжуємо TTL лише для перевіреної актуальної сесії.
        await this.redis.expire(
            key,
            SESSION_TTL_SECONDS,
        );

        return {
            session,
            peerId: participants.otherUserId,
            role: session.offererId === userId
                ? 'OFFERER'
                : 'ANSWERER',
        };
    }

    private async getChatParticipants(
        userId: string,
        chatId: string,
    ): Promise<ChatParticipants> {
        this.validateUserId( userId );

        const chat = await this.prisma.privateChat.findUnique( {
            where: { id: chatId },
            select: {
                id: true,
                creatorId: true,
                peerId: true,
                status: true,
            },
        } );

        if ( !chat ) {
            throw new NotFoundException( 'Чат не знайдено' );
        }

        if ( chat.status !== 'ACTIVE' ) {
            throw new ForbiddenException( 'Чат ще не активний' );
        }

        const users = await this.prisma.user.findMany( {
            where: {
                id: {
                    in: [ chat.creatorId, chat.peerId ],
                },
            },
            select: {
                id: true,
                userId: true,
            },
        } );

        const creator = users.find(
            ( user ) => user.id === chat.creatorId,
        );

        const peer = users.find(
            ( user ) => user.id === chat.peerId,
        );

        if ( !creator || !peer ) {
            throw new NotFoundException(
                'Не вдалося знайти учасників чату',
            );
        }

        const creatorUserId = String( creator.userId );
        const peerUserId = String( peer.userId );

        if (
            userId !== creatorUserId &&
            userId !== peerUserId
        ) {
            throw new ForbiddenException(
                'Немає доступу до цього чату',
            );
        }

        return {
            creatorUserId,
            peerUserId,
            otherUserId: userId === creatorUserId
                ? peerUserId
                : creatorUserId,
        };
    }

    private isValidSessionForParticipants(
        session: WebRtcSession,
        chatId: string,
        creatorUserId: string,
        peerUserId: string,
    ): boolean {
        const samePair =
            (
                session.userA === creatorUserId &&
                session.userB === peerUserId
            ) ||
            (
                session.userA === peerUserId &&
                session.userB === creatorUserId
            );

        return (
            session.chatId === chatId &&
            typeof session.sessionId === 'string' &&
            samePair
        );
    }

    private toPresence(
        userId: string,
        peerId: string,
        session: WebRtcSession,
    ): ChatPresence {
        const role: WebRtcRole =
            session.offererId === userId
                ? 'OFFERER'
                : 'ANSWERER';

        return {
            chatId: session.chatId,
            peerId,
            ready: true,
            role,
            peerRole: role === 'OFFERER'
                ? 'ANSWERER'
                : 'OFFERER',
            offererId: session.offererId,
            sessionId: session.sessionId,
            previousChatId: null,
        };
    }

    private notReadyState(
        chatId: string,
        peerId: string,
    ): ChatPresence {
        return {
            chatId,
            peerId,
            ready: false,
            role: null,
            peerRole: null,
            offererId: null,
            sessionId: null,
            previousChatId: null,
        };
    }

    private validateUserId( userId: string ): void {
        if ( !/^\d{10}$/.test( userId ) ) {
            throw new ForbiddenException(
                'Некоректний ідентифікатор користувача',
            );
        }
    }

    private getSessionKey( chatId: string ): string {
        return `avertoo:webrtc:session:${ chatId }`;
    }
}
