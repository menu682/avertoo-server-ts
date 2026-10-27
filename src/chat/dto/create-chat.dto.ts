import {
    IsString,
    Matches,
} from 'class-validator';

export class CreateChatDto {
    @IsString()
    @Matches( /^\d{10}$/, {
        message: 'peerId must have 10 digits',
    } )
    peerId!: string;
}