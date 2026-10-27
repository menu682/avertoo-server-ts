import { Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

@Injectable()
export class WebSocketValidationService {
    async validatePayload<T extends object>(
        dtoClass: new () => T,
        payload: unknown,
    ): Promise<T> {
        const input =
            payload !== null &&
            typeof payload === 'object' &&
            !Array.isArray( payload )
                ? payload
                : {};

        const dto = plainToInstance( dtoClass, input );

        const errors = await validate( dto, {
            whitelist: true,
            forbidNonWhitelisted: true,
            forbidUnknownValues: true,
        } );

        if ( errors.length > 0 ) {
            const details = errors.flatMap( ( error ) =>
                Object.values( error.constraints ?? {} ),
            );

            throw new WsException( {
                code: 'VALIDATION_ERROR',
                message: 'Некоректні дані запиту',
                details,
            } );
        }

        return dto;
    }
}
