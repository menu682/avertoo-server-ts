import { Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

import {
    Prisma,
    PrivateChatStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PUBLIC_USER_ID_PATTERN = /^\d{10}$/;
const MAX_TRANSACTION_RETRIES = 3;

@Injectable()
export class ChatService {
    constructor(
        private readonly prisma: PrismaService,
    ) {
    }

    async getChats( userId: string ) {
        const user = await this.getUserByPublicId( userId );

        const chats = await this.prisma.privateChat.findMany( {
            where: {
                OR: [
                    { creatorId: user.id },
                    { peerId: user.id },
                ],
            },
            orderBy: {
                updatedAt: 'desc',
            },
        } );

        const participantIds = [
            ...new Set(
                chats.map( ( chat ) =>
                    chat.creatorId === user.id
                        ? chat.peerId
                        : chat.creatorId,
                ),
            ),
        ];

        const participants = await this.prisma.user.findMany( {
            where: {
                id: { in: participantIds },
            },
            select: {
                id: true,
                userId: true,
            },
        } );

        const publicIds = new Map(
            participants.map( ( participant ) => [
                participant.id,
                participant.userId.toString(),
            ] ),
        );

        return chats.map( ( chat ) => {
            const participantId =
                chat.creatorId === user.id
                    ? chat.peerId
                    : chat.creatorId;

            const peerId = publicIds.get( participantId );

            if ( !peerId ) {
                throw new WsException( {
                    code: 'CHAT_PARTICIPANT_NOT_FOUND',
                    message: 'Не вдалося знайти учасника чату',
                } );
            }

            return {
                id: chat.id,
                peerId,
                status: chat.status,
                updatedAt: chat.updatedAt.toISOString(),
            };
        } );
    }

    async createChat( userId: string, peerId: string ) {
        this.validatePublicUserId( peerId );

        const initiator = await this.getUserByPublicId( userId );
        const recipient = await this.getUserByPublicId( peerId );

        if ( initiator.id === recipient.id ) {
            throw new WsException( {
                code: 'CANNOT_CHAT_WITH_SELF',
                message: 'Не можна створити чат із самим собою',
            } );
        }

        for ( let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++ ) {
            try {
                return await this.prisma.$transaction(
                    async ( tx ) => {
                        const existing = await tx.privateChat.findFirst( {
                            where: {
                                OR: [
                                    {
                                        creatorId: initiator.id,
                                        peerId: recipient.id,
                                    },
                                    {
                                        creatorId: recipient.id,
                                        peerId: initiator.id,
                                    },
                                ],
                            },
                        } );

                        if ( !existing ) {
                            const chat = await tx.privateChat.create( {
                                data: {
                                    creatorId: initiator.id,
                                    peerId: recipient.id,
                                    status: PrivateChatStatus.PENDING,
                                },
                            } );

                            return {
                                id: chat.id,
                                peerId: recipient.userId.toString(),
                                status: chat.status,
                            };
                        }

                        if (
                            existing.status === PrivateChatStatus.ACTIVE ||
                            existing.creatorId === initiator.id
                        ) {
                            return {
                                id: existing.id,
                                peerId: recipient.userId.toString(),
                                status: existing.status,
                            };
                        }

                        const activated = await tx.privateChat.update( {
                            where: {
                                id: existing.id,
                            },
                            data: {
                                status: PrivateChatStatus.ACTIVE,
                            },
                        } );

                        return {
                            id: activated.id,
                            peerId: recipient.userId.toString(),
                            status: activated.status,
                        };
                    },
                    {
                        isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                    },
                );
            } catch ( error ) {
                const isSerializationConflict =
                    error instanceof Prisma.PrismaClientKnownRequestError &&
                    error.code === 'P2034';

                if (
                    isSerializationConflict &&
                    attempt < MAX_TRANSACTION_RETRIES
                ) {
                    continue;
                }

                if ( isSerializationConflict ) {
                    throw new WsException( {
                        code: 'CHAT_CONFLICT',
                        message:
                            'Не вдалося обробити запит через одночасну зміну чату. Спробуй ще раз',
                    } );
                }

                throw error;
            }
        }

        throw new WsException( {
            code: 'CHAT_CONFLICT',
            message: 'Не вдалося створити або активувати чат',
        } );
    }


    async deleteChat( userId: string, chatId: string ) {
        const user = await this.getUserByPublicId( userId );

        const chat = await this.prisma.privateChat.findUnique( {
            where: { id: chatId },
        } );

        if ( !chat ) {
            throw new WsException( {
                code: 'CHAT_NOT_FOUND',
                message: 'Чат не знайдено',
            } );
        }

        if (
            chat.creatorId !== user.id &&
            chat.peerId !== user.id
        ) {
            throw new WsException( {
                code: 'CHAT_FORBIDDEN',
                message: 'Ти не є учасником цього чату',
            } );
        }

        const participants = await this.prisma.user.findMany( {
            where: {
                id: {
                    in: [ chat.creatorId, chat.peerId ],
                },
            },
            select: {
                userId: true,
            },
        } );

        await this.prisma.privateChat.delete( {
            where: { id: chat.id },
        } );

        return {
            chatId: chat.id,
            participantUserIds: participants.map(
                ( participant ) => participant.userId.toString(),
            ),
        };
    }


    private async getUserByPublicId( userId: string ) {
        this.validatePublicUserId( userId );

        const user = await this.prisma.user.findUnique( {
            where: {
                userId: BigInt( userId ),
            },
        } );

        if ( !user ) {
            throw new WsException( {
                code: 'USER_NOT_FOUND',
                message: 'Користувача не знайдено',
            } );
        }

        return user;
    }

    private validatePublicUserId( userId: string ): void {
        if ( !PUBLIC_USER_ID_PATTERN.test( userId ) ) {
            throw new WsException( {
                code: 'INVALID_USER_ID',
                message: 'ID користувача повинен містити рівно 10 цифр',
            } );
        }
    }
}
