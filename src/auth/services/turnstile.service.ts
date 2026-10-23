import { ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";


interface TurnstileVerificationResponse {
    success: boolean,
    hostname?: string,
    'error-codes'?: string[];
}

@Injectable()
export class TurnstileService {

    private readonly secretKey: string;

    constructor( private readonly configService: ConfigService ) {
        const secretKey =
            this.configService.get<string>( 'TURNSTILE_SECRET_KEY' );

        if ( !secretKey ) {
            throw new Error( 'TURNSTILE_SECRET_KEY is not configured' )
        }

        this.secretKey = secretKey;
    }

    async verify( token: string ): Promise<void> {

        let response: Response;

        try {
            response = await fetch(
                'https://challenges.cloudflare.com/turnstile/v0/siteverify',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams( {
                        secret: this.secretKey,
                        response: token,
                    } ),
                    signal: AbortSignal.timeout( 5000 ),
                },
            );
        } catch {
            throw new ServiceUnavailableException(
                'CAPTCHA verification service is unavailable',
            );
        }


        if ( !response.ok ) {
            throw new ServiceUnavailableException(
                'CAPTCHA verification service returned an error',
            );
        }

        let result: TurnstileVerificationResponse;

        try {
            result = await response.json() as TurnstileVerificationResponse;
        } catch {
            throw new ServiceUnavailableException(
                'Invalid response from CAPTCHA verification service'
            );
        }

        if ( !result.success ) {
            throw new ForbiddenException(
                'CAPTCHA verification failed'
            )
        }
    }
}
