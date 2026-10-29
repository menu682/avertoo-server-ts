import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { RedisModule } from './redis/redis.module.js';
import { WebSocketModule } from './websocket/websocket.module.js';
import { TurnCredentialsModule } from './turn-credentials/turn-credentials.module.js';

@Module( {
    imports: [
        ConfigModule.forRoot( { isGlobal: true } ),
        ScheduleModule.forRoot(),
        PrismaModule,
        RedisModule,
        AuthModule,
        WebSocketModule,
        TurnCredentialsModule,
    ],
    controllers: [ AppController ],
    providers: [ AppService ],
} )
export class AppModule {
}
