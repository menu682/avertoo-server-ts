import { randomUUID } from 'node:crypto';

import {
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    WsException,
} from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { RedisClientType } from 'redis';
import type { Server, Socket } from 'socket.io';

import { RedisService } from '../redis/redis.service.js';
import { ChatService } from '../chat/chat.service.js';
import { CreateChatDto } from '../chat/dto/create-chat.dto.js';
import { DeleteChatDto } from '../chat/dto/delete-chat.dto.js';

const CONNECTION_TTL_SECONDS = 90;

interface AccessTokenPayload {
    userId: string;
}

interface ConnectionRecord {
    userId: string;
    socketId: string;
    instanceId: string;
}

@WebSocketGateway( {
    namespace: '/foreground',
    transports: [ 'websocket' ],
    pingInterval: 25_000,
    pingTimeout: 20_000,
} )
export class WebSocketGatewayService
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger( WebSocketGatewayService.name );

    private readonly redis: RedisClientType;

    private readonly instanceId =
        process.env.SERVER_INSTANCE_ID ?? randomUUID();

    @WebSocketServer()
    server!: Server;

    constructor(
        private readonly jwtService: JwtService,
        redisService: RedisService,
        private readonly chatService: ChatService,
    ) {
        this.redis = redisService.getClient();
    }

    afterInit( server: Server ): void {
        server.use( ( socket, next ) => {
            void this.authenticate( socket )
                .then( () => next() )
                .catch( () => {
                    next( new Error( 'Unauthorized' ) );
                } );
        } );
    }

    private async authenticate( socket: Socket ): Promise<void> {
        const token = socket.handshake.auth?.token;

        if ( typeof token !== 'string' || token.length === 0 ) {
            throw new UnauthorizedException();
        }

        const payload =
            await this.jwtService.verifyAsync<AccessTokenPayload>( token );

        if (
            typeof payload.userId !== 'string' ||
            !/^\d{10}$/.test( payload.userId )
        ) {
            throw new UnauthorizedException();
        }

        socket.data.userId = payload.userId;
    }

    async handleConnection( socket: Socket ): Promise<void> {
        const userId = socket.data.userId as string | undefined;

        if ( !userId ) {
            socket.disconnect( true );
            return;
        }

        const record: ConnectionRecord = {
            userId,
            socketId: socket.id,
            instanceId: this.instanceId,
        };

        const key = this.getConnectionKey( userId );

        try {
            const previousValue = await this.redis.eval(
                `
                local previous = redis.call('GET', KEYS[1])
                redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
                return previous
                `,
                {
                    keys: [ key ],
                    arguments: [
                        JSON.stringify( record ),
                        String( CONNECTION_TTL_SECONDS ),
                    ],
                },
            );

            if ( typeof previousValue === 'string' ) {
                try {
                    const previous =
                        JSON.parse( previousValue ) as ConnectionRecord;

                    if (
                        typeof previous.socketId === 'string' &&
                        previous.socketId !== socket.id
                    ) {
                        this.server
                            .in( previous.socketId )
                            .disconnectSockets( true );
                    }
                } catch {
                    this.logger.warn(
                        `Invalid previous connection record for user ${ userId }`,
                    );
                }
            }

            // Персональна кімната дає змогу повідомляти користувача
            // через Socket.IO та Redis adapter, навіть на іншому сервері.
            await socket.join( this.getUserRoom( userId ) );

            socket.conn.on( 'packet', ( packet ) => {
                if ( packet.type !== 'pong' ) {
                    return;
                }

                void this.refreshConnection( record ).then(
                    ( refreshed ) => {
                        if ( !refreshed ) {
                            this.logger.warn(
                                `Connection record lost: user=${ userId }, socket=${ socket.id }`,
                            );

                            socket.disconnect( true );
                        }
                    },
                    ( error: unknown ) => {
                        this.logger.error(
                            `Could not refresh connection for user ${ userId }: ${
                                error instanceof Error
                                    ? error.message
                                    : String( error )
                            }`,
                        );
                    },
                );
            } );

            this.logger.log(
                `Foreground socket connected: user=${ userId }, socket=${ socket.id }, instance=${ this.instanceId }`,
            );

            socket.emit( 'connection.ready', {
                userId,
                socketId: socket.id,
                instanceId: this.instanceId,
            } );
        } catch ( error ) {
            this.logger.error(
                `Could not register socket ${ socket.id }`,
                error instanceof Error ? error.stack : String( error ),
            );

            socket.disconnect( true );
        }
    }

    async handleDisconnect( socket: Socket ): Promise<void> {
        const userId = socket.data.userId as string | undefined;

        if ( !userId ) {
            return;
        }

        const key = this.getConnectionKey( userId );

        try {
            await this.redis.eval(
                `
                local value = redis.call('GET', KEYS[1])

                if value then
                    local record = cjson.decode(value)

                    if record.socketId == ARGV[1]
                       and record.instanceId == ARGV[2] then
                        return redis.call('DEL', KEYS[1])
                    end
                end

                return 0
                `,
                {
                    keys: [ key ],
                    arguments: [ socket.id, this.instanceId ],
                },
            );

            this.logger.log(
                `Foreground socket disconnected: user=${ userId }, socket=${ socket.id }`,
            );
        } catch ( error ) {
            this.logger.error(
                `Could not remove socket record for ${ userId }`,
                error instanceof Error ? error.stack : String( error ),
            );
        }
    }

    @SubscribeMessage( 'chats.list' )
    async handleChatsList(
        @ConnectedSocket() socket: Socket,
    ): Promise<void> {
        try {
            const userId = this.getSocketUserId( socket );
            const chats = await this.chatService.getChats( userId );

            socket.emit( 'chats.list.updated', { chats } );
        } catch ( error ) {
            this.emitChatError( socket, error );
        }
    }

    @SubscribeMessage( 'chats.create' )
    async handleCreateChat(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.getSocketUserId( socket );
            const dto = await this.validatePayload(
                CreateChatDto,
                payload,
            );

            const chat = await this.chatService.createChat(
                userId,
                dto.peerId,
            );

            socket.emit( 'chats.chat.updated', chat );

            await this.emitUpdatedLists( [
                userId,
                chat.peerId,
            ] );
        } catch ( error ) {
            this.emitChatError( socket, error );
        }
    }

    @SubscribeMessage( 'chats.delete' )
    async handleDeleteChat(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.getSocketUserId( socket );
            const dto = await this.validatePayload(
                DeleteChatDto,
                payload,
            );

            const result = await this.chatService.deleteChat(
                userId,
                dto.chatId,
            );

            for ( const participantUserId of result.participantUserIds ) {
                this.server
                    .to( this.getUserRoom( participantUserId ) )
                    .emit( 'chats.chat.deleted', {
                        chatId: result.chatId,
                    } );
            }

            await this.emitUpdatedLists( result.participantUserIds );
        } catch ( error ) {
            this.emitChatError( socket, error );
        }
    }

    private async validatePayload<T extends object>(
        dtoClass: new () => T,
        payload: unknown,
    ): Promise<T> {
        const input =
            payload !== null &&
            typeof payload === 'object' &&
            !Array.isArray( payload )
                ? payload
                : {};

        const dto = plainToInstance( dtoClass, input );

        const errors = await validate( dto, {
            whitelist: true,
            forbidNonWhitelisted: true,
            forbidUnknownValues: true,
        } );

        if ( errors.length > 0 ) {
            const details = errors.flatMap( ( error ) =>
                Object.values( error.constraints ?? {} ),
            );

            throw new WsException( {
                code: 'VALIDATION_ERROR',
                message: 'Некоректні дані запиту',
                details,
            } );
        }

        return dto;
    }

    private getSocketUserId( socket: Socket ): string {
        const userId = socket.data.userId;

        if (
            typeof userId !== 'string' ||
            !/^\d{10}$/.test( userId )
        ) {
            throw new WsException( {
                code: 'UNAUTHORIZED',
                message: 'Необхідна авторизація',
            } );
        }

        return userId;
    }

    private async emitUpdatedLists( userIds: string[] ): Promise<void> {
        for ( const userId of new Set( userIds ) ) {
            try {
                const chats = await this.chatService.getChats( userId );

                this.server
                    .to( this.getUserRoom( userId ) )
                    .emit( 'chats.list.updated', { chats } );
            } catch ( error ) {
                this.logger.error(
                    `Could not update chat list for user ${ userId }`,
                    error instanceof Error ? error.stack : String( error ),
                );
            }
        }
    }

    private emitChatError( socket: Socket, error: unknown ): void {
        if ( error instanceof WsException ) {
            const response = error.getError();

            if ( typeof response === 'string' ) {
                socket.emit( 'chats.error', {
                    code: 'CHAT_ERROR',
                    message: response,
                } );
            } else {
                socket.emit( 'chats.error', response );
            }

            return;
        }

        this.logger.error(
            'Chat operation failed',
            error instanceof Error ? error.stack : String( error ),
        );

        socket.emit( 'chats.error', {
            code: 'INTERNAL_ERROR',
            message: 'Не вдалося виконати операцію з чатом',
        } );
    }

    private async refreshConnection(
        record: ConnectionRecord,
    ): Promise<boolean> {
        const result = await this.redis.eval(
            `
            local value = redis.call('GET', KEYS[1])

            if value then
                local current = cjson.decode(value)

                if current.socketId == ARGV[1]
                   and current.instanceId == ARGV[2] then
                    return redis.call('EXPIRE', KEYS[1], ARGV[3])
                end
            end

            return 0
            `,
            {
                keys: [ this.getConnectionKey( record.userId ) ],
                arguments: [
                    record.socketId,
                    record.instanceId,
                    String( CONNECTION_TTL_SECONDS ),
                ],
            },
        );

        return result === 1;
    }

    private getConnectionKey( userId: string ): string {
        return `avertoo:foreground:${ userId }`;
    }

    private getUserRoom( userId: string ): string {
        return `user:${ userId }`;
    }
}
