import {
    IsString,
    IsUUID,
} from 'class-validator';

export class DeleteChatDto {
    @IsString()
    @IsUUID( '7', {
        message: 'chatId must be UUID v7',
    } )
    chatId!: string;
}