import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import { RedisService } from '../redis/redis.service.js';

export class RedisIoAdapter extends IoAdapter {
    private adapterConstructor?: ReturnType<typeof createAdapter>;
    private closeSubscriber?: () => Promise<void>;

    constructor(
        app: INestApplicationContext,
        private readonly redisService: RedisService,
    ) {
        super( app );
    }

    async connectToRedis(): Promise<void> {
        const publisher = this.redisService.getClient();
        const subscriber = publisher.duplicate();

        await subscriber.connect();

        this.closeSubscriber = async () => {
            if ( subscriber.isOpen ) {
                await subscriber.quit();
            }
        };

        this.adapterConstructor = createAdapter(
            publisher as Parameters<typeof createAdapter>[0],
            subscriber as Parameters<typeof createAdapter>[1],
        );
    }

    override createIOServer(
        port: number,
        options?: ServerOptions,
    ) {
        if ( !this.adapterConstructor ) {
            throw new Error( 'Redis Socket.IO adapter is not initialized' );
        }

        const server = super.createIOServer( port, options );

        server.adapter( this.adapterConstructor );

        return server;
    }

    async closeRedisConnections(): Promise<void> {
        await this.closeSubscriber?.();
    }


}