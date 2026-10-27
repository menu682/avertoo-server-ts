import { Injectable } from '@nestjs/common';
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { WebSocketAuthService } from './websocket-auth.service.js';
import { WebSocketConnectionService } from './websocket-connection.service.js';
import { WebSocketChatService } from './websocket-chat.service.js';
import { WebSocketWebRtcService } from './websocket-webrtc.service.js';

@WebSocketGateway( {
    namespace: '/foreground',
    transports: [ 'websocket' ],
    pingInterval: 25_000,
    pingTimeout: 20_000,
} )
@Injectable()
export class WebSocketGatewayService
    implements OnGatewayInit,
        OnGatewayConnection,
        OnGatewayDisconnect {
    @WebSocketServer()
    server!: Server;

    constructor(
        private readonly authService: WebSocketAuthService,
        private readonly connectionService: WebSocketConnectionService,
        private readonly chatService: WebSocketChatService,
        private readonly webRtcService: WebSocketWebRtcService,
    ) {
    }

    afterInit( server: Server ): void {
        server.use( ( socket, next ) => {
            void this.authService
                .authenticate( socket )
                .then( () => next() )
                .catch( () => {
                    next( new Error( 'Unauthorized' ) );
                } );
        } );
    }

    async handleConnection( socket: Socket ): Promise<void> {
        const userId = socket.data.userId;

        if (
            typeof userId !== 'string' ||
            !/^\d{10}$/.test( userId )
        ) {
            socket.disconnect( true );
            return;
        }

        await this.connectionService.registerConnection(
            this.server,
            socket,
            userId,
        );
    }

    async handleDisconnect( socket: Socket ): Promise<void> {
        await this.webRtcService.handleDisconnect( this.server, socket );
        await this.connectionService.removeConnection( socket );
    }

    @SubscribeMessage( 'chats.list' )
    async handleChatsList(
        @ConnectedSocket() socket: Socket,
    ): Promise<void> {
        await this.chatService.list( socket );
    }

    @SubscribeMessage( 'chats.create' )
    async handleCreateChat(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.chatService.create(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'chats.delete' )
    async handleDeleteChat(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.chatService.delete(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'webrtc.chat.open' )
    async handleWebRtcChatOpen(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.webRtcService.openChat(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'webrtc.chat.close' )
    async handleWebRtcChatClose(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.webRtcService.closeChat(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'webrtc.signal' )
    async handleWebRtcSignal(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.webRtcService.signal(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'webrtc.session.status' )
    async handleWebRtcSessionStatus(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.webRtcService.reportSessionStatus(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'webrtc.session.end' )
    async handleWebRtcSessionEnd(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.webRtcService.endSession(
            this.server,
            socket,
            payload,
        );
    }

    @SubscribeMessage( 'webrtc.session.restart' )
    async handleWebRtcSessionRestart(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: unknown,
    ): Promise<void> {
        await this.webRtcService.restartSession(
            this.server,
            socket,
            payload,
        );
    }
}
