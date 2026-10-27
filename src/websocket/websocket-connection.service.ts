import {
    Injectable,
    Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { Server, Socket } from 'socket.io';

import { RedisService } from '../redis/redis.service.js';
import type { ConnectionRecord } from './websocket.types.js';

const CONNECTION_TTL_SECONDS = 90;

@Injectable()
export class WebSocketConnectionService {
    private readonly logger = new Logger(
        WebSocketConnectionService.name,
    );

    private readonly redis: RedisClientType;

    private readonly instanceId =
        process.env.SERVER_INSTANCE_ID ?? randomUUID();

    constructor( redisService: RedisService ) {
        this.redis = redisService.getClient();
    }

    async registerConnection(
        server: Server,
        socket: Socket,
        userId: string,
    ): Promise<void> {
        const record: ConnectionRecord = {
            userId,
            socketId: socket.id,
            instanceId: this.instanceId,
        };

        try {
            const previousValue = await this.redis.eval(
                `
                local previous = redis.call('GET', KEYS[1])
                redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
                return previous
                `,
                {
                    keys: [ this.getConnectionKey( userId ) ],
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
                        server
                            .in( previous.socketId )
                            .disconnectSockets( true );
                    }
                } catch {
                    this.logger.warn(
                        `Invalid previous connection record for user ${ userId }`,
                    );
                }
            }

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

    async removeConnection( socket: Socket ): Promise<void> {
        const userId = socket.data.userId as string | undefined;

        if ( !userId ) {
            return;
        }

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
                    keys: [ this.getConnectionKey( userId ) ],
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

    private getUserRoom( userId: string ): string {
        return `user:${ userId }`;
    }
}
