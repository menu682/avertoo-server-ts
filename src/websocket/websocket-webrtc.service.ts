import {
    HttpException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { CloseChatDto } from '../webrtc/dto/close-chat.dto.js';
import { OpenChatDto } from '../webrtc/dto/open-chat.dto.js';
import { WebRtcSignalDto } from '../webrtc/dto/webrtc-signal.dto.js';
import {
    EndWebRtcSessionDto,
    WebRtcSessionStatusDto,
} from '../webrtc/dto/webrtc-session.dto.js';
import { WebRtcService } from '../webrtc/webrtc.service.js';
import { WebSocketAuthService } from './websocket-auth.service.js';
import { WebSocketValidationService } from './websocket-validation.service.js';

@Injectable()
export class WebSocketWebRtcService {
    private readonly logger = new Logger(
        WebSocketWebRtcService.name,
    );

    constructor(
        private readonly webRtcService: WebRtcService,
        private readonly authService: WebSocketAuthService,
        private readonly validationService: WebSocketValidationService,
    ) {
    }

    async openChat(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                OpenChatDto,
                payload,
            );

            await this.webRtcService.assertChatAccess( userId, dto.chatId );
            await socket.join( this.getChatRoom( dto.chatId ) );
            this.rememberOpenChat( socket, dto.chatId );
            const openSockets = await server
                .in( this.getChatRoom( dto.chatId ) )
                .fetchSockets();
            const peerHasChatOpen = openSockets.some(
                ( openSocket ) => openSocket.data.userId !== userId,
            );

            const result = await this.webRtcService.openChat(
                userId,
                dto.chatId,
                peerHasChatOpen,
            );
            const state = result.state;

            if ( result.replacedSessionId ) {
                const ended = {
                    chatId: dto.chatId,
                    sessionId: result.replacedSessionId,
                    fromUserId: userId,
                };
                socket.emit( 'webrtc.session.ended', ended );
                server.to( this.getUserRoom( state.peerId ) ).emit(
                    'webrtc.session.ended',
                    ended,
                );
            }

            socket.emit( 'webrtc.chat.state', state );

            if ( state.ready && state.sessionId ) {
                server
                    .to( this.getUserRoom( state.peerId ) )
                    .emit( 'webrtc.chat.state', {
                        chatId: state.chatId,
                        peerId: userId,
                        ready: true,
                        role: state.peerRole,
                        peerRole: state.role,
                        offererId: state.offererId,
                        sessionId: state.sessionId,
                        previousChatId: null,
                    } );
            }
        } catch ( error ) {
            this.emitError( socket, error );
        }
    }

    async signal(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                WebRtcSignalDto,
                payload,
            );

            const result = await this.webRtcService.relaySignal(
                userId,
                dto,
            );

            server
                .to( this.getUserRoom( result.peerId ) )
                .emit( 'webrtc.signal', result.signal );

            socket.emit( 'webrtc.signal.sent', {
                chatId: dto.chatId,
                sessionId: dto.sessionId,
                type: dto.type,
            } );
        } catch ( error ) {
            this.emitError( socket, error );
        }
    }

    async reportSessionStatus(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                WebRtcSessionStatusDto,
                payload,
            );

            const result =
                await this.webRtcService.reportSessionStatus(
                    userId,
                    dto,
                );

            server
                .to( this.getUserRoom( result.peerId ) )
                .emit( 'webrtc.session.status', {
                    chatId: dto.chatId,
                    sessionId: dto.sessionId,
                    fromUserId: userId,
                    status: result.status,
                } );

            socket.emit( 'webrtc.session.status.ack', {
                chatId: dto.chatId,
                sessionId: dto.sessionId,
                status: result.status,
            } );
        } catch ( error ) {
            this.emitError( socket, error );
        }
    }

    async endSession(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                EndWebRtcSessionDto,
                payload,
            );

            const result = await this.webRtcService.endSession(
                userId,
                dto,
            );

            if ( result.ended ) {
                server
                    .to( this.getUserRoom( result.peerId ) )
                    .emit( 'webrtc.session.ended', {
                        chatId: dto.chatId,
                        sessionId: dto.sessionId,
                        fromUserId: userId,
                    } );
            }

            socket.emit( 'webrtc.session.end.ack', {
                chatId: dto.chatId,
                sessionId: dto.sessionId,
                ended: result.ended,
            } );
        } catch ( error ) {
            this.emitError( socket, error );
        }
    }

    async restartSession(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                EndWebRtcSessionDto,
                payload,
            );

            const result = await this.webRtcService.restartSession(
                userId,
                dto,
            );

            socket.emit( 'webrtc.chat.state', {
                ...result.state,
                restarted: true,
            } );

            server
                .to( this.getUserRoom( result.peerId ) )
                .emit( 'webrtc.chat.state', {
                    ...result.state,
                    peerId: userId,
                    role: result.state.peerRole,
                    peerRole: result.state.role,
                    restarted: true,
                } );
        } catch ( error ) {
            this.emitError( socket, error );
        }
    }

    async closeChat(
        server: Server,
        socket: Socket,
        payload: unknown,
    ): Promise<void> {
        try {
            const userId = this.authService.getSocketUserId( socket );

            const dto = await this.validationService.validatePayload(
                CloseChatDto,
                payload,
            );

            await socket.leave( this.getChatRoom( dto.chatId ) );
            this.forgetOpenChat( socket, dto.chatId );
            const result = await this.webRtcService.closeChat( userId, dto.chatId );

            server.to( this.getUserRoom( result.peerId ) ).emit(
                'webrtc.chat.closed',
                { chatId: dto.chatId, fromUserId: userId },
            );
            if ( result.sessionId ) {
                server.to( this.getUserRoom( result.peerId ) ).emit(
                    'webrtc.session.ended',
                    { chatId: dto.chatId, sessionId: result.sessionId, fromUserId: userId },
                );
            }
            socket.emit( 'webrtc.chat.close.ack', { chatId: dto.chatId } );
        } catch ( error ) {
            this.emitError( socket, error );
        }
    }

    async handleDisconnect( server: Server, socket: Socket ): Promise<void> {
        const userId = this.authService.getSocketUserId( socket );
        const chatIds = this.getOpenChatIds( socket );

        for ( const chatId of chatIds ) {
            try {
                const result = await this.webRtcService.closeChat( userId, chatId );
                server.to( this.getUserRoom( result.peerId ) ).emit(
                    'webrtc.chat.closed',
                    { chatId, fromUserId: userId },
                );
                if ( result.sessionId ) {
                    server.to( this.getUserRoom( result.peerId ) ).emit(
                        'webrtc.session.ended',
                        { chatId, sessionId: result.sessionId, fromUserId: userId },
                    );
                }
            } catch ( error ) {
                this.logger.warn(
                    `Could not close WebRTC chat ${ chatId } after disconnect: ${ error instanceof Error ? error.message : String( error ) }`,
                );
            }
        }
    }

    private emitError(
        socket: Socket,
        error: unknown,
    ): void {
        if ( error instanceof WsException ) {
            const response = error.getError();

            socket.emit(
                'webrtc.error',
                typeof response === 'string'
                    ? {
                        code: 'WEBRTC_ERROR',
                        message: response,
                    }
                    : response,
            );

            return;
        }

        if ( error instanceof HttpException ) {
            const response = error.getResponse();

            const message =
                typeof response === 'string'
                    ? response
                    : typeof response === 'object' &&
                    response !== null &&
                    'message' in response
                        ? response.message
                        : error.message;

            socket.emit( 'webrtc.error', {
                code: `HTTP_${ error.getStatus() }`,
                message,
            } );

            return;
        }

        this.logger.error(
            'WebRTC operation failed',
            error instanceof Error
                ? error.stack
                : String( error ),
        );

        socket.emit( 'webrtc.error', {
            code: 'INTERNAL_ERROR',
            message: 'Не вдалося виконати WebRTC-операцію',
        } );
    }

    private getUserRoom( userId: string ): string {
        return `user:${ userId }`;
    }

    private getChatRoom( chatId: string ): string {
        return `webrtc:chat:${ chatId }`;
    }

    private getOpenChatIds( socket: Socket ): string[] {
        const ids = socket.data.webrtcOpenChatIds;
        return Array.isArray( ids ) ? ids.filter( ( id ): id is string => typeof id === 'string' ) : [];
    }

    private rememberOpenChat( socket: Socket, chatId: string ): void {
        const ids = this.getOpenChatIds( socket );
        if ( !ids.includes( chatId ) ) {
            socket.data.webrtcOpenChatIds = [ ...ids, chatId ];
        }
    }

    private forgetOpenChat( socket: Socket, chatId: string ): void {
        socket.data.webrtcOpenChatIds = this.getOpenChatIds( socket ).filter(
            ( id ) => id !== chatId,
        );
    }

}
