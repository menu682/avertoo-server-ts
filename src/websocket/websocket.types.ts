export interface AccessTokenPayload {
    userId: string;
}

export interface ConnectionRecord {
    userId: string;
    socketId: string;
    instanceId: string;
}