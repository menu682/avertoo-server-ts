import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { RedisModule } from './redis/redis.module.js';
import { WebSocketModule } from './websocket/websocket.module.js';

@Module( {
    imports: [
        ConfigModule.forRoot( { isGlobal: true } ),
        PrismaModule,
        RedisModule,
        AuthModule,
        WebSocketModule,
    ],
    controllers: [ AppController ],
    providers: [ AppService ],
} )
export class AppModule {
}