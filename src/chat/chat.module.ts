import { Module } from '@nestjs/common';

import { ChatService } from './chat.service.js';
import { ChatCleanupService } from './chat-cleanup.service.js';

@Module( {
    providers: [
        ChatService,
        ChatCleanupService,
    ],
    exports: [ ChatService ],
} )
export class ChatModule {
}