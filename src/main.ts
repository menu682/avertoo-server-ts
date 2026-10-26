import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';

import { AppModule } from './app.module.js';
import { RedisService } from './redis/redis.service.js';
import { RedisIoAdapter } from './websocket/redis-io.adapter.js';

async function bootstrap() {
    const app = await NestFactory.create( AppModule );

    app.useGlobalPipes(
        new ValidationPipe( {
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        } ),
    );

    const redisService = app.get( RedisService );
    await redisService.connect();

    const redisAdapter = new RedisIoAdapter( app, redisService );
    await redisAdapter.connectToRedis();

    app.useWebSocketAdapter( redisAdapter );

    app.enableShutdownHooks();

    await app.listen( process.env.PORT ?? 3000 );
}

await bootstrap();