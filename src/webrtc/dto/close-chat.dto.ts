import { IsUUID } from 'class-validator';

export class CloseChatDto {
    @IsUUID()
    chatId!: string;
}
