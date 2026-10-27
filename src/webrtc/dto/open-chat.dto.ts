import { IsUUID } from 'class-validator';

export class OpenChatDto {
    @IsUUID()
    chatId!: string;
}
