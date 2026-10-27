import {
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';

import type { AccessTokenPayload } from './websocket.types.js';

@Injectable()
export class WebSocketAuthService {
    constructor(
        private readonly jwtService: JwtService,
    ) {}

    async authenticate(socket: Socket): Promise<void> {
        const token = socket.handshake.auth?.token;

        if (typeof token !== 'string' || token.length === 0) {
            throw new UnauthorizedException();
        }

        const payload =
            await this.jwtService.verifyAsync<AccessTokenPayload>(token);

        if (
            typeof payload.userId !== 'string' ||
            !/^\d{10}$/.test(payload.userId)
        ) {
            throw new UnauthorizedException();
        }

        socket.data.userId = payload.userId;
    }

    getSocketUserId(socket: Socket): string {
        const userId = socket.data.userId;

        if (
            typeof userId !== 'string' ||
            !/^\d{10}$/.test(userId)
        ) {
            throw new UnauthorizedException();
        }

        return userId;
    }
}