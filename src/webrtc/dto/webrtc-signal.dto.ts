import {
    IsIn,
    IsObject,
    IsUUID,
} from 'class-validator';

export class WebRtcSignalDto {
    @IsUUID()
    chatId!: string;

    @IsUUID()
    sessionId!: string;

    @IsIn( [ 'offer', 'answer', 'ice-candidate' ] )
    type!: 'offer' | 'answer' | 'ice-candidate';

    @IsObject()
    data!: Record<string, unknown>;
}