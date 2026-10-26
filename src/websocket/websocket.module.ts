import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { WebSocketGatewayService } from './websocket.gateway.js';

@Module( {
    imports: [
        AuthModule,
        RedisModule,
    ],
    providers: [ WebSocketGatewayService ],
} )
export class WebSocketModule {
}