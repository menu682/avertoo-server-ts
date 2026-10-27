import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrivateChatStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PENDING_CHAT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class ChatCleanupService {
    private readonly logger = new Logger( ChatCleanupService.name );

    constructor(
        private readonly prisma: PrismaService,
    ) {
    }

    @Cron( CronExpression.EVERY_HOUR )
    async deleteExpiredPendingChats(): Promise<void> {
        const expiresBefore = new Date(
            Date.now() - PENDING_CHAT_TTL_MS,
        );

        try {
            const result = await this.prisma.privateChat.deleteMany( {
                where: {
                    status: PrivateChatStatus.PENDING,
                    createdAt: {
                        lt: expiresBefore,
                    },
                },
            } );

            if ( result.count > 0 ) {
                this.logger.log(
                    `Deleted ${ result.count } expired pending chat(s)`,
                );
            }
        } catch ( error ) {
            this.logger.error(
                'Failed to delete expired pending chats',
                error instanceof Error ? error.stack : String( error ),
            );
        }
    }
}