import {
    Injectable,
    Logger,
} from '@nestjs/common';

import { WsException } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { ChatService } from '../chat/chat.service.js';
import { CreateChatDto } from '../chat/dto/create-chat.dto.js';
import { DeleteChatDto } from '../chat/dto/delete-chat.dto.js';
import { WebSocketAuthService } from './websocket-auth.service.js';
import { WebSocketValidationService } from './websocket-validation.service.js';

@Injectable()
export class WebSocketChatService {
    private readonly logger = new Logger(
        WebSocketChatService.name,
    );

    constructor(
        private readonly chatService: ChatService,
        private readonly authService: WebSocketAuthService,
        private readonly validationService: WebSocketValidationService,
    ) {
    }

    async list( socket: Socket ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );
            const chats = await this.chatService.getChats( userId );

            socket.emit( 'chats.list.updated', { chats } );
        } catch ( error ) {
            this.emitChatError( socket, error );
        }
    }

    async create(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                CreateChatDto,
                payload,
            );

            const chat = await this.chatService.createChat(
                userId,
                dto.peerId,
            );

            socket.emit( 'chats.chat.updated', chat );

            await this.emitUpdatedLists( server, [
                userId,
                chat.peerId,
            ] );
        } catch ( error ) {
            this.emitChatError( socket, error );
        }
    }

    async delete(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                DeleteChatDto,
                payload,
            );

            const result = await this.chatService.deleteChat(
                userId,
                dto.chatId,
            );

            for ( const participantUserId of result.participantUserIds ) {
                server
                    .to( this.getUserRoom( participantUserId ) )
                    .emit( 'chats.chat.deleted', {
                        chatId: result.chatId,
                    } );
            }

            await this.emitUpdatedLists(
                server,
                result.participantUserIds,
            );
        } catch ( error ) {
            this.emitChatError( socket, error );
        }
    }

    private async emitUpdatedLists(
        server: Server,
        userIds: string[],
    ): Promise<void> {
        for ( const userId of new Set( userIds ) ) {
            try {
                const chats = await this.chatService.getChats( userId );

                server
                    .to( this.getUserRoom( userId ) )
                    .emit( 'chats.list.updated', { chats } );
            } catch ( error ) {
                this.logger.error(
                    `Could not update chat list for user ${ userId }`,
                    error instanceof Error
                        ? error.stack
                        : String( error ),
                );
            }
        }
    }

    private emitChatError( socket: Socket, error: unknown ): void {
        if ( error instanceof WsException ) {
            const response = error.getError();

            if ( typeof response === 'string' ) {
                socket.emit( 'chats.error', {
                    code: 'CHAT_ERROR',
                    message: response,
                } );
            } else {
                socket.emit( 'chats.error', response );
            }

            return;
        }

        this.logger.error(
            'Chat operation failed',
            error instanceof Error ? error.stack : String( error ),
        );

        socket.emit( 'chats.error', {
            code: 'INTERNAL_ERROR',
            message: 'Не вдалося виконати операцію з чатом',
        } );
    }

    private getUserRoom( userId: string ): string {
        return `user:${ userId }`;
    }
}
