import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AuthService } from './services/auth.service.js';
import { AuthController } from './controllers/auth.controller.js';
import { TurnstileService } from './services/turnstile.service.js';

@Module( {
    imports: [
        JwtModule.registerAsync( {
            inject: [ ConfigService ],
            useFactory: ( configService: ConfigService ) => {
                const secret = configService.get<string>(
                    'JWT_ACCESS_SECRET',
                );

                if ( !secret ) {
                    throw new Error( 'JWT_ACCESS_SECRET is not configured' );
                }

                return {
                    secret,
                    signOptions: {
                        expiresIn: '30h',
                    },
                };
            },
        } ),
    ],
    controllers: [ AuthController ],
    providers: [ AuthService, TurnstileService ],
    exports: [ AuthService, JwtModule ],
} )
export class AuthModule {
}