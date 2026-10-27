import {
    IsIn,
    IsUUID,
} from 'class-validator';

export class WebRtcSessionStatusDto {
    @IsUUID()
    chatId!: string;

    @IsUUID()
    sessionId!: string;

    @IsIn( [
        'connecting',
        'connected',
        'disconnected',
        'failed',
    ] )
    status!: 'connecting' | 'connected' | 'disconnected' | 'failed';
}

export class EndWebRtcSessionDto {
    @IsUUID()
    chatId!: string;

    @IsUUID()
    sessionId!: string;
}