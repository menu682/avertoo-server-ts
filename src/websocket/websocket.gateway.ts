import { randomUUID } from 'node:crypto';

import {
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import type { RedisClientType } from 'redis';
import type { Server, Socket } from 'socket.io';

import { RedisService } from '../redis/redis.service.js';

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
            // Атомарно реєструємо нове з'єднання та отримуємо попереднє.
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

            // Використовуємо системний heartbeat Socket.IO.
            // Коли приходить pong, оновлюємо TTL запису в Redis.
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
            // Старий сокет не може видалити запис нового сокета.
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
}