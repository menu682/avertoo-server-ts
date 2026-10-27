import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module.js';
import { WebRtcService } from './webrtc.service.js';

@Module( {
    imports: [ RedisModule ],
    providers: [ WebRtcService ],
    exports: [ WebRtcService ],
} )
export class WebRtcModule {
}
