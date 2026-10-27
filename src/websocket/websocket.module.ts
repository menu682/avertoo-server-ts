import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { WebRtcModule } from '../webrtc/webrtc.module.js';

import { WebSocketGatewayService } from './websocket.gateway.js';
import { WebSocketAuthService } from './websocket-auth.service.js';
import { WebSocketConnectionService } from './websocket-connection.service.js';
import { WebSocketChatService } from './websocket-chat.service.js';
import { WebSocketValidationService } from './websocket-validation.service.js';
import { WebSocketWebRtcService } from './websocket-webrtc.service.js';

@Module( {
    imports: [
        AuthModule,
        RedisModule,
        ChatModule,
        WebRtcModule,
    ],
    providers: [
        WebSocketGatewayService,
        WebSocketAuthService,
        WebSocketConnectionService,
        WebSocketChatService,
        WebSocketValidationService,
        WebSocketWebRtcService,
    ],
} )
export class WebSocketModule {
}
