import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger( RedisService.name );
    private readonly client: RedisClientType;
    private connecting?: Promise<void>;

    constructor() {
        const url = process.env.REDIS_URL;
        const password = process.env.REDIS_PASSWORD;

        if ( !url ) {
            throw new Error( 'REDIS_URL is not configured' );
        }

        if ( !password ) {
            throw new Error( 'REDIS_PASSWORD is not configured' );
        }

        this.client = createClient( {
            url,
            password,
        } );

        this.client.on( 'error', ( error: Error ) => {
            this.logger.error( `Redis error: ${ error.message }` );
        } );
    }

    async onModuleInit(): Promise<void> {
        await this.connect();
    }

    async connect(): Promise<void> {
        if ( this.client.isOpen ) {
            return;
        }

        if ( !this.connecting ) {
            this.connecting = this.client
                .connect()
                .then( () => {
                    this.logger.log( 'Connected to Redis' );
                } )
                .finally( () => {
                    this.connecting = undefined;
                } );
        }

        await this.connecting;
    }

    getClient(): RedisClientType {
        return this.client;
    }

    async onModuleDestroy(): Promise<void> {
        if ( this.client.isOpen ) {
            await this.client.quit();
        }
    }
}